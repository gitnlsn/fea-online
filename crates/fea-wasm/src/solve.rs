//! Browser-facing surface over the `fea-dg` discontinuous Galerkin solver.
//!
//! The solver's own API is closure-generic: an equation carries its source as a
//! type parameter, and a boundary condition is a struct wrapped around an `Fn`.
//! None of that crosses a JSON boundary, so this module's job is to turn a
//! declarative request into those types, and to do it without ever reaching an
//! assertion inside the library.
//!
//! ## Panics are not errors here
//!
//! `LdgOperator::new` asserts that every boundary tag has a condition,
//! `Robin::absorbing` asserts a positive coefficient, `Poisson::with_conductivity`
//! asserts a positive conductivity. Each of those is reachable straight from a
//! request. In a normal program that is fine; inside wasm a panic aborts the
//! instance and takes the worker with it, so a single bad number would leave the
//! UI permanently unable to solve rather than showing a message. Everything that
//! could trip an assertion is therefore checked in [`validate`] first, and the
//! table of checks there is a mirror of the library's assertions, not a
//! defensive habit.
//!
//! ## Coordinates are not normalised
//!
//! [`crate::build_mesh`] rescales its input into a unit box because the mesher's
//! geometric predicates were scale-sensitive. This does the opposite, and the
//! asymmetry is deliberate: the solver's predicates are already scale-invariant
//! and conjugate gradient's tolerance is relative, while Neumann and Robin data
//! are fluxes *per unit length*. Rescaling coordinates without also rescaling
//! those would silently change the problem being solved -- and rescaling them
//! correctly would mean the user's numbers no longer mean what they typed.

use serde::{Deserialize, Serialize};

use fea_dg::mesh::boundary::{BoundaryCondition, Dirichlet, Neumann, Robin};
use fea_dg::mesh::dg_mesh::DgMesh;
use fea_dg::reference::dubiner::mode_count;
use fea_dg::reference::element::ReferenceElement;
use fea_dg::solver::residual::LdgOperator;
use fea_dg::{solve_steady, Poisson, SteadyOptions};

use crate::classify::classify_boundary;
use crate::sample::sample_field;

/// Highest polynomial degree offered.
///
/// Not a limit of the solver -- it is tested to `p = 5` and unbounded in code --
/// but the cost per element grows like `(p+1)(p+2)/2` modes with a condition
/// number going like `p^4`, and past this the wait stops feeling interactive.
const MAX_DEGREE: usize = 4;

/// Highest display lattice order.
const MAX_SUBDIVISIONS: usize = 4;

/// Ceiling on `elements * modes`, the size of the coefficient vector.
///
/// Without a ceiling an over-refined mesh at `p = 4` does not fail, it simply
/// never finishes, and a tab that has stopped responding tells the user nothing
/// about which knob to turn. Refusing names both.
const MAX_DEGREES_OF_FREEDOM: usize = 400_000;

#[derive(Debug, Deserialize)]
pub struct SolveRequest {
    /// Interleaved `[x0, y0, ...]` -- exactly `MeshResponse::vertices`.
    ///
    /// The mesh travels in the request rather than being rebuilt here on
    /// purpose. The caller already holds it, it is what is drawn on screen, and
    /// `known_issues::repeated_identical_requests_are_stable` records that an
    /// identical mesh request is not guaranteed to produce an identical mesh --
    /// so re-meshing could put the field on a mesh the user is not looking at.
    pub vertices: Vec<f64>,
    /// Interleaved corner indices -- exactly `MeshResponse::triangles`.
    pub triangles: Vec<u32>,

    /// The edges of the drawn loops, interleaved `[ax, ay, bx, by, ...]`.
    pub segments: Vec<f64>,
    /// One tag per segment, indexing `conditions`.
    pub segment_tags: Vec<u16>,
    /// The condition each tag names. Callers are expected to deduplicate, so
    /// that four sides held at the same value share one entry.
    pub conditions: Vec<ConditionSpec>,

    #[serde(default = "default_conductivity")]
    pub conductivity: f64,
    #[serde(default)]
    pub source: SourceSpec,
    #[serde(default = "default_degree")]
    pub degree: usize,

    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    /// Interface penalty multiplier; `None` takes the solver's own default.
    #[serde(default)]
    pub penalty: Option<f64>,

    /// Display lattice order: `subdivisions^2` sub-triangles per element.
    #[serde(default = "default_subdivisions")]
    pub subdivisions: usize,
}

fn default_conductivity() -> f64 {
    1.0
}
fn default_degree() -> usize {
    1
}
fn default_tolerance() -> f64 {
    1e-10
}
fn default_max_iterations() -> usize {
    5_000
}
fn default_subdivisions() -> usize {
    2
}

/// A boundary condition, as the UI states it.
///
/// The sign conventions are the solver's and are worth restating because both
/// read backwards at a glance. `J` is the *flux*, so for `J = -k grad u` a
/// Neumann value is the outward flux and equals `-k du/dn`; and the textbook
/// dissipative Robin condition `k du/dn + c u = g` with `c > 0` is what
/// `Robin::absorbing` builds, which is why nothing here constructs `Robin::new`
/// with raw coefficients.
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConditionSpec {
    /// `u = value`
    Dirichlet { value: f64 },
    /// `J . n = value`, the outward flux.
    Neumann { value: f64 },
    /// `k du/dn + coefficient * u = value`, with `coefficient > 0`.
    Robin { coefficient: f64, value: f64 },
}

/// The volumetric source `s(x)`.
///
/// A tagged enum with one variant looks like over-engineering, and is not: it
/// makes an analytic menu additive on both sides of the wire later, whereas a
/// bare `f64` would have to be replaced.
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceSpec {
    Constant { value: f64 },
}

impl Default for SourceSpec {
    fn default() -> Self {
        SourceSpec::Constant { value: 0.0 }
    }
}

#[derive(Debug, Serialize)]
pub struct SolveResponse {
    /// Interleaved `[x, y]` per sample point, element-major.
    pub positions: Vec<f32>,
    /// The field at each sample point.
    pub values: Vec<f32>,
    /// Sub-triangle corners as local lattice indices, shared by every element.
    pub sub_triangles: Vec<u32>,
    /// Sample points per element.
    pub sample_stride: usize,
    pub subdivisions: usize,

    pub element_count: usize,
    pub mode_count: usize,
    pub degree: usize,

    /// Extremes of `values`, so the legend describes what is drawn.
    pub min_value: f64,
    pub max_value: f64,

    pub iterations: usize,
    pub residual_norm: f64,
    pub initial_norm: f64,
    /// False when the iteration hit its cap. The field is still returned -- it
    /// is the best iterate -- but it does not solve the problem to tolerance,
    /// and nothing else about it looks different.
    pub converged: bool,

    /// The problem fixes the solution only up to an additive constant, which
    /// happens when no Dirichlet or Robin condition appears anywhere. The
    /// driver pins the constant, so the field is drawable, but its level is
    /// arbitrary -- and an incompatible pure-Neumann problem returns a
    /// plausible-looking least-squares answer with no other warning.
    pub singular: bool,
    /// Boundary faces no segment claimed. Nonzero means the conditions near
    /// them are not the ones that were asked for.
    pub unclassified_faces: usize,
    /// Largest accepted face-to-segment distance, relative to the mesh
    /// diameter. Round-off in normal use.
    pub worst_match_distance: f64,
}

/// A boundary condition whose value function is boxed.
///
/// The library's `Dirichlet<F>` and friends are generic over the closure type,
/// and every closure has its own anonymous type, so a runtime-sized `Vec` of
/// them cannot be built directly. `Box<dyn Fn(..)>` itself implements `Fn`, so
/// boxing the closure keeps the library's own types -- and with them its sign
/// conventions -- rather than re-deriving `alpha` and `beta` by hand here,
/// which is precisely the mistake `Robin`'s documentation warns about.
type ValueFn = Box<dyn Fn([f64; 2], [f64; 2], f64) -> [f64; 1]>;

enum OwnedCondition {
    Dirichlet(Dirichlet<ValueFn>),
    Neumann(Neumann<ValueFn>),
    Robin(Robin<ValueFn, 1>),
}

impl BoundaryCondition<1> for OwnedCondition {
    fn coefficients(&self) -> ([f64; 1], [f64; 1]) {
        match self {
            OwnedCondition::Dirichlet(condition) => condition.coefficients(),
            OwnedCondition::Neumann(condition) => condition.coefficients(),
            OwnedCondition::Robin(condition) => condition.coefficients(),
        }
    }

    fn value(&self, x: [f64; 2], normal: [f64; 2], t: f64) -> [f64; 1] {
        match self {
            OwnedCondition::Dirichlet(condition) => condition.value(x, normal, t),
            OwnedCondition::Neumann(condition) => condition.value(x, normal, t),
            OwnedCondition::Robin(condition) => condition.value(x, normal, t),
        }
    }
}

fn build_condition(spec: &ConditionSpec) -> OwnedCondition {
    match *spec {
        ConditionSpec::Dirichlet { value } => {
            OwnedCondition::Dirichlet(Dirichlet(Box::new(move |_, _, _| [value])))
        }
        ConditionSpec::Neumann { value } => {
            OwnedCondition::Neumann(Neumann(Box::new(move |_, _, _| [value])))
        }
        ConditionSpec::Robin { coefficient, value } => OwnedCondition::Robin(Robin::absorbing(
            [coefficient],
            Box::new(move |_, _, _| [value]) as ValueFn,
        )),
    }
}

/// Everything that could otherwise reach an assertion inside the solver.
///
/// Each check below corresponds to a specific `assert!` in `fea-dg` or to an
/// input the solver would accept and then spend an unbounded amount of time on.
fn validate(request: &SolveRequest) -> Result<(), String> {
    if request.vertices.is_empty() || request.triangles.is_empty() {
        return Err("the request carries no mesh".into());
    }
    if request.vertices.iter().any(|value| !value.is_finite()) {
        return Err("the mesh contains a non-finite coordinate".into());
    }

    if request.segments.len() % 4 != 0 {
        return Err(format!(
            "segments must come in groups of four coordinates; got {}",
            request.segments.len()
        ));
    }
    if request.segments.len() != request.segment_tags.len() * 4 {
        return Err(format!(
            "{} segments were sent with {} tags",
            request.segments.len() / 4,
            request.segment_tags.len()
        ));
    }
    if request.segments.iter().any(|value| !value.is_finite()) {
        return Err("a boundary segment has a non-finite coordinate".into());
    }

    // `LdgOperator::new` asserts every tag is in range, and unmatched faces fall
    // back to tag 0 -- so tag 0 must exist even when no segment names it.
    if request.conditions.is_empty() {
        return Err("no boundary conditions were supplied".into());
    }
    if let Some(&tag) = request
        .segment_tags
        .iter()
        .find(|&&tag| tag as usize >= request.conditions.len())
    {
        return Err(format!(
            "a boundary segment is tagged {tag}, but only {} conditions were supplied",
            request.conditions.len()
        ));
    }

    for condition in &request.conditions {
        match *condition {
            ConditionSpec::Dirichlet { value } | ConditionSpec::Neumann { value } => {
                if !value.is_finite() {
                    return Err("a boundary condition has a non-finite value".into());
                }
            }
            ConditionSpec::Robin { coefficient, value } => {
                if !value.is_finite() {
                    return Err("a boundary condition has a non-finite value".into());
                }
                // `Robin::absorbing` asserts this. A non-positive coefficient is
                // the anti-dissipative case, which makes the operator indefinite
                // and conjugate gradient meaningless.
                if !(coefficient > 0.0) || !coefficient.is_finite() {
                    return Err(format!(
                        "a convection coefficient must be positive; got {coefficient}"
                    ));
                }
            }
        }
    }

    // `Poisson::with_conductivity` asserts this.
    if !(request.conductivity > 0.0) || !request.conductivity.is_finite() {
        return Err(format!(
            "conductivity must be positive; got {}",
            request.conductivity
        ));
    }
    let SourceSpec::Constant { value } = request.source;
    if !value.is_finite() {
        return Err("the source term is not finite".into());
    }

    if request.degree < 1 || request.degree > MAX_DEGREE {
        return Err(format!(
            "polynomial degree must be between 1 and {MAX_DEGREE}; got {}",
            request.degree
        ));
    }
    if request.subdivisions < 1 || request.subdivisions > MAX_SUBDIVISIONS {
        return Err(format!(
            "subdivisions must be between 1 and {MAX_SUBDIVISIONS}; got {}",
            request.subdivisions
        ));
    }
    if !(request.tolerance > 0.0) || !request.tolerance.is_finite() {
        return Err(format!(
            "the solver tolerance must be positive; got {}",
            request.tolerance
        ));
    }
    if request.max_iterations == 0 {
        return Err("the iteration cap must be at least 1".into());
    }
    // `LdgOperator::with_penalty` asserts this.
    if let Some(penalty) = request.penalty {
        if penalty < 0.0 || !penalty.is_finite() {
            return Err(format!("the interface penalty must not be negative; got {penalty}"));
        }
    }

    let elements = request.triangles.len() / 3;
    let unknowns = elements.saturating_mul(mode_count(request.degree));
    if unknowns > MAX_DEGREES_OF_FREEDOM {
        return Err(format!(
            "this problem has {unknowns} unknowns, above the {MAX_DEGREES_OF_FREEDOM} \
             ceiling. Use a larger maximum element area, or a lower polynomial degree."
        ));
    }

    Ok(())
}

/// Solves a steady diffusion problem and samples the answer for display.
///
/// Pure: no state is retained between calls.
pub fn solve_problem(request: SolveRequest) -> Result<SolveResponse, String> {
    validate(&request)?;

    // Declaration order below is the lifetime contract. `operator` borrows from
    // `owned`, `mesh`, `reference`, `equation` and the classification, and Rust
    // drops locals in reverse order -- so declaring every borrowed thing before
    // the operator is all that is needed. No `Rc`, no arena.
    let mesh = DgMesh::from_arrays(&request.vertices, &request.triangles)
        .map_err(|error| format!("the mesh cannot be solved on: {error}"))?;

    let reference = ReferenceElement::new(request.degree);
    let SourceSpec::Constant { value: source } = request.source;
    let equation = Poisson::with_conductivity(request.conductivity, move |_| source);

    let owned: Vec<OwnedCondition> = request.conditions.iter().map(build_condition).collect();

    // Tag 0 is the fallback for a face no segment claims; `validate` has already
    // established that it exists.
    let classification = classify_boundary(&mesh, &request.segments, &request.segment_tags, 0);

    let conditions: Vec<&dyn BoundaryCondition<1>> = owned
        .iter()
        .map(|condition| condition as &dyn BoundaryCondition<1>)
        .collect();

    let mut operator = match request.penalty {
        Some(penalty) => LdgOperator::with_penalty(
            &mesh,
            &reference,
            &equation,
            &classification.map,
            conditions,
            penalty,
        ),
        None => LdgOperator::new(&mesh, &reference, &equation, &classification.map, conditions),
    };

    let singular = operator.is_singular();

    let options = SteadyOptions {
        tolerance: request.tolerance,
        max_iterations: request.max_iterations,
        preconditioned: true,
    };
    let (solution, report) = solve_steady(&mut operator, &options);

    let sampled = sample_field(&mesh, &solution, request.degree, request.subdivisions);

    Ok(SolveResponse {
        positions: sampled.positions,
        values: sampled.values,
        sub_triangles: sampled.sub_triangles,
        sample_stride: sampled.stride,
        subdivisions: request.subdivisions,
        element_count: mesh.n_elements(),
        mode_count: reference.n_modes(),
        degree: request.degree,
        min_value: sampled.min,
        max_value: sampled.max,
        iterations: report.iterations,
        residual_norm: report.residual_norm,
        initial_norm: report.initial_norm,
        converged: report.converged,
        singular,
        unclassified_faces: classification.unclassified,
        worst_match_distance: classification.worst_relative_distance,
    })
}

#[cfg(test)]
mod fixtures {
    use super::*;
    use crate::{build_mesh, MeshRequest};

    pub const UNIT_SQUARE: [[f64; 2]; 4] = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];

    /// Edges of a closed loop, flattened into the segment table.
    pub fn segments_of(loop_points: &[[f64; 2]]) -> Vec<f64> {
        let n = loop_points.len();
        (0..n)
            .flat_map(|i| {
                let a = loop_points[i];
                let b = loop_points[(i + 1) % n];
                [a[0], a[1], b[0], b[1]]
            })
            .collect()
    }

    /// A request over a meshed unit square. `tags` are per side, running
    /// bottom, right, top, left -- the order `segments_of` produces.
    pub fn square_request(
        max_area: f64,
        tags: [u16; 4],
        conditions: Vec<ConditionSpec>,
    ) -> SolveRequest {
        let meshed = build_mesh(MeshRequest {
            boundary: UNIT_SQUARE.to_vec(),
            holes: vec![],
            min_angle_deg: 25.0,
            max_area: Some(max_area),
            max_steps: None,
            max_triangles: None,
        })
        .unwrap();

        SolveRequest {
            vertices: meshed.vertices,
            triangles: meshed.triangles,
            segments: segments_of(&UNIT_SQUARE),
            segment_tags: tags.to_vec(),
            conditions,
            conductivity: 1.0,
            source: SourceSpec::Constant { value: 0.0 },
            degree: 1,
            tolerance: 1e-12,
            max_iterations: 5_000,
            penalty: None,
            subdivisions: 2,
        }
    }
}

#[cfg(test)]
mod steady_solve {
    use super::fixtures::*;
    use super::*;

    /// The canonical test, and the one a browser session should reproduce by
    /// hand: held at 0 on the left and 1 on the right, insulated top and bottom,
    /// no source. The answer is `u = x`, which a degree-1 basis represents
    /// exactly, so this is not a convergence check with a loose tolerance -- any
    /// discrepancy beyond round-off is a real defect.
    ///
    /// It exercises the whole chain at once: classification put the conditions
    /// on the right sides, the Neumann sign did not leak a flux into the
    /// insulated walls, the operator is the diffusion operator, and sampling
    /// reports positions and values that belong together.
    #[test]
    fn a_linear_field_is_reproduced_exactly() {
        let response = solve_problem(square_request(
            0.01,
            [1, 2, 1, 0],
            vec![
                ConditionSpec::Dirichlet { value: 0.0 },
                ConditionSpec::Neumann { value: 0.0 },
                ConditionSpec::Dirichlet { value: 1.0 },
            ],
        ))
        .unwrap();

        assert!(response.converged, "{response:?}");
        assert!(!response.singular);
        assert_eq!(response.unclassified_faces, 0);

        for index in 0..response.values.len() {
            let x = response.positions[index * 2] as f64;
            let value = response.values[index] as f64;
            assert!(
                (value - x).abs() < 1e-5,
                "u = {value} at x = {x}, expected u = x"
            );
        }

        assert!(response.min_value.abs() < 1e-5);
        assert!((response.max_value - 1.0).abs() < 1e-5);
    }

    /// Dirichlet data alone, all the same. Nothing drives the field away from
    /// the boundary value, so a constant is the whole answer -- and a constant
    /// is the shape a sign error in the penalty or the boundary lifting cannot
    /// survive.
    #[test]
    fn constant_dirichlet_data_gives_a_constant_field() {
        let response = solve_problem(square_request(
            0.02,
            [0, 0, 0, 0],
            vec![ConditionSpec::Dirichlet { value: 3.5 }],
        ))
        .unwrap();

        assert!(response.converged);
        assert!((response.min_value - 3.5).abs() < 1e-6, "{}", response.min_value);
        assert!((response.max_value - 3.5).abs() < 1e-6, "{}", response.max_value);
    }

    /// With a source and homogeneous Dirichlet data, the response scales as
    /// `1/k`. Establishes that conductivity reaches the operator rather than
    /// being accepted and dropped -- which nothing else here would catch,
    /// because every other test uses `k = 1`.
    #[test]
    fn conductivity_scales_the_response() {
        let solve_at = |conductivity: f64| {
            let mut request = square_request(
                0.02,
                [0, 0, 0, 0],
                vec![ConditionSpec::Dirichlet { value: 0.0 }],
            );
            request.conductivity = conductivity;
            request.source = SourceSpec::Constant { value: 1.0 };
            solve_problem(request).unwrap()
        };

        let unit = solve_at(1.0);
        let double = solve_at(2.0);
        assert!(unit.converged && double.converged);

        let ratio = unit.max_value / double.max_value;
        assert!(
            (ratio - 2.0).abs() < 0.02,
            "doubling k changed the peak by a factor of {ratio}, expected 2"
        );
    }

    /// Insulated all round with no source: the field is fixed only up to an
    /// additive constant. The driver pins it, so this must return an answer
    /// rather than dividing by a zero pivot -- but it must also say so, because
    /// the level of the field it draws is arbitrary.
    #[test]
    fn a_pure_neumann_problem_is_flagged_singular() {
        let response = solve_problem(square_request(
            0.02,
            [0, 0, 0, 0],
            vec![ConditionSpec::Neumann { value: 0.0 }],
        ))
        .unwrap();

        assert!(response.singular, "a pure Neumann problem must be flagged");
        assert!(response.max_value - response.min_value < 1e-6);
    }

    /// A Robin wall is the third boundary path, and the one whose sign
    /// convention reads backwards. With `u = 0` driven from the opposite side
    /// the absorbing wall must pull the field towards zero rather than away
    /// from it -- an inverted sign still converges, to the wrong answer.
    #[test]
    fn an_absorbing_wall_stays_between_its_neighbours() {
        let response = solve_problem(square_request(
            0.02,
            [1, 2, 1, 0],
            vec![
                ConditionSpec::Dirichlet { value: 0.0 },
                ConditionSpec::Neumann { value: 0.0 },
                ConditionSpec::Robin {
                    coefficient: 2.0,
                    value: 2.0,
                },
            ],
        ))
        .unwrap();

        assert!(response.converged);
        // Held at 0 on the left, absorbing towards u = 1 on the right: the
        // field must rise left to right and stay inside [0, 1].
        assert!(response.min_value > -1e-6, "{}", response.min_value);
        assert!(response.max_value < 1.0, "{}", response.max_value);
        assert!(response.max_value > 0.3, "{}", response.max_value);
    }

    /// An explicit penalty equal to the library's default must reproduce the
    /// default path exactly. If it did not, the two branches in `solve_problem`
    /// would be doing different things and only one of them would be tested.
    #[test]
    fn the_default_penalty_matches_an_explicit_one() {
        let build = |penalty: Option<f64>| {
            let mut request = square_request(
                0.02,
                [1, 2, 1, 0],
                vec![
                    ConditionSpec::Dirichlet { value: 0.0 },
                    ConditionSpec::Neumann { value: 0.0 },
                    ConditionSpec::Dirichlet { value: 1.0 },
                ],
            );
            request.penalty = penalty;
            solve_problem(request).unwrap()
        };

        let implicit = build(None);
        let explicit = build(Some(fea_dg::solver::residual::DEFAULT_PENALTY));
        assert_eq!(implicit.values, explicit.values);
    }

    /// A hole is a second boundary loop, and its faces must answer to their own
    /// tag. A hot inclusion in a cold plate is the shape this feature exists to
    /// draw, and it is also the one where mis-classification is invisible:
    /// wrong-but-smooth still looks like a solution.
    #[test]
    fn a_hole_carries_its_own_condition() {
        use crate::{build_mesh, MeshRequest};

        let hole = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]];
        let meshed = build_mesh(MeshRequest {
            boundary: UNIT_SQUARE.to_vec(),
            holes: vec![hole.to_vec()],
            min_angle_deg: 25.0,
            max_area: Some(0.01),
            max_steps: None,
            max_triangles: None,
        })
        .unwrap();

        let mut segments = segments_of(&UNIT_SQUARE);
        segments.extend(segments_of(&hole));

        let response = solve_problem(SolveRequest {
            vertices: meshed.vertices,
            triangles: meshed.triangles,
            segments,
            segment_tags: vec![0, 0, 0, 0, 1, 1, 1, 1],
            conditions: vec![
                ConditionSpec::Dirichlet { value: 0.0 },
                ConditionSpec::Dirichlet { value: 1.0 },
            ],
            conductivity: 1.0,
            source: SourceSpec::Constant { value: 0.0 },
            degree: 1,
            tolerance: 1e-12,
            max_iterations: 5_000,
            penalty: None,
            subdivisions: 2,
        })
        .unwrap();

        assert!(response.converged);
        assert_eq!(response.unclassified_faces, 0);
        // The maximum principle: with boundary data spanning [0, 1] and no
        // source, the field must too. A hole tagged as outer wall would
        // collapse the whole field to zero instead.
        assert!(response.max_value > 0.9, "{}", response.max_value);
        assert!(response.min_value < 0.1, "{}", response.min_value);
    }

    /// The response's shape has to be self-consistent, or the renderer indexes
    /// past the end of an array on a mesh nobody tested at.
    #[test]
    fn the_response_arrays_line_up() {
        let response = solve_problem(square_request(
            0.05,
            [0, 0, 0, 0],
            vec![ConditionSpec::Dirichlet { value: 1.0 }],
        ))
        .unwrap();

        assert_eq!(
            response.values.len(),
            response.element_count * response.sample_stride
        );
        assert_eq!(response.positions.len(), response.values.len() * 2);
        assert_eq!(
            response.sub_triangles.len(),
            3 * response.subdivisions * response.subdivisions
        );
        assert!(response
            .sub_triangles
            .iter()
            .all(|&corner| (corner as usize) < response.sample_stride));
    }
}

#[cfg(test)]
mod rejected_requests {
    use super::fixtures::*;
    use super::*;

    /// Each case here is reachable from the UI and would otherwise reach an
    /// assertion inside `fea-dg`. An assertion inside wasm aborts the instance
    /// and kills the worker, so "returns an error" and "panics" are not two
    /// shades of the same outcome: the second one ends the session.
    fn rejected(mutate: impl FnOnce(&mut SolveRequest)) -> String {
        let mut request = square_request(
            0.05,
            [0, 0, 0, 0],
            vec![ConditionSpec::Dirichlet { value: 0.0 }],
        );
        mutate(&mut request);
        solve_problem(request).expect_err("the request should have been rejected")
    }

    #[test]
    fn a_tag_with_no_condition_is_rejected() {
        assert!(rejected(|request| request.segment_tags = vec![0, 0, 0, 7]).contains("tagged 7"));
    }

    #[test]
    fn an_empty_condition_table_is_rejected() {
        assert!(rejected(|request| request.conditions.clear()).contains("no boundary conditions"));
    }

    #[test]
    fn a_non_positive_convection_coefficient_is_rejected() {
        assert!(rejected(|request| {
            request.conditions = vec![ConditionSpec::Robin {
                coefficient: 0.0,
                value: 1.0,
            }];
        })
        .contains("must be positive"));
    }

    #[test]
    fn a_non_positive_conductivity_is_rejected() {
        assert!(rejected(|request| request.conductivity = 0.0).contains("conductivity"));
        assert!(rejected(|request| request.conductivity = -1.0).contains("conductivity"));
    }

    #[test]
    fn an_out_of_range_degree_is_rejected() {
        assert!(rejected(|request| request.degree = 0).contains("degree"));
        assert!(rejected(|request| request.degree = MAX_DEGREE + 1).contains("degree"));
    }

    #[test]
    fn an_out_of_range_subdivision_count_is_rejected() {
        assert!(rejected(|request| request.subdivisions = 0).contains("subdivisions"));
        assert!(rejected(|request| request.subdivisions = 99).contains("subdivisions"));
    }

    #[test]
    fn a_non_positive_tolerance_is_rejected() {
        assert!(rejected(|request| request.tolerance = 0.0).contains("tolerance"));
    }

    #[test]
    fn a_zero_iteration_cap_is_rejected() {
        assert!(rejected(|request| request.max_iterations = 0).contains("at least 1"));
    }

    #[test]
    fn a_negative_penalty_is_rejected() {
        assert!(rejected(|request| request.penalty = Some(-1.0)).contains("penalty"));
    }

    #[test]
    fn mismatched_segments_and_tags_are_rejected() {
        assert!(rejected(|request| request.segment_tags = vec![0, 0]).contains("tags"));
        assert!(rejected(|request| {
            request.segments.pop();
        })
        .contains("groups of four"));
    }

    #[test]
    fn a_non_finite_number_is_rejected() {
        assert!(rejected(|request| request.vertices[0] = f64::NAN).contains("non-finite"));
        assert!(rejected(|request| request.segments[0] = f64::INFINITY).contains("non-finite"));
        assert!(rejected(|request| {
            request.conditions = vec![ConditionSpec::Dirichlet { value: f64::NAN }];
        })
        .contains("non-finite"));
        assert!(rejected(|request| {
            request.source = SourceSpec::Constant { value: f64::NAN };
        })
        .contains("source"));
    }

    #[test]
    fn an_empty_mesh_is_rejected() {
        assert!(rejected(|request| request.triangles.clear()).contains("no mesh"));
    }

    /// A mesh the solver itself rejects must surface as its own message rather
    /// than as a panic from inside `from_arrays`.
    #[test]
    fn a_malformed_mesh_is_rejected_with_the_solvers_own_reason() {
        let message = rejected(|request| {
            request.triangles = vec![0, 1, 999_999];
        });
        assert!(message.contains("cannot be solved on"), "{message}");
    }

    /// The cost ceiling. Without it this request does not fail, it hangs.
    #[test]
    fn an_oversized_problem_is_refused_rather_than_attempted() {
        let message = rejected(|request| {
            request.degree = 4;
            // 400k unknowns at 15 modes needs about 27k elements; claim more.
            request.triangles = vec![0, 1, 2].repeat(40_000);
        });
        assert!(message.contains("ceiling"), "{message}");
        assert!(
            message.contains("area") && message.contains("degree"),
            "the refusal must name the knobs to turn: {message}"
        );
    }
}

#[cfg(test)]
mod wire_format {
    use super::*;

    /// Pins the JSON the web app has to emit.
    ///
    /// The tagged representation is what makes these a discriminated union on
    /// the TypeScript side, and it is decided by an attribute that can be
    /// changed without breaking any Rust caller -- so the wire shape is pinned
    /// here rather than left to be discovered from the browser.
    #[test]
    fn conditions_are_internally_tagged() {
        let cases = [
            (
                ConditionSpec::Dirichlet { value: 1.5 },
                r#"{"kind":"dirichlet","value":1.5}"#,
            ),
            (
                ConditionSpec::Neumann { value: -2.0 },
                r#"{"kind":"neumann","value":-2.0}"#,
            ),
            (
                ConditionSpec::Robin {
                    coefficient: 3.0,
                    value: 4.0,
                },
                r#"{"kind":"robin","coefficient":3.0,"value":4.0}"#,
            ),
        ];

        for (spec, json) in cases {
            assert_eq!(serde_json::to_string(&spec).unwrap(), json);
            assert_eq!(
                serde_json::from_str::<ConditionSpec>(json).unwrap(),
                spec,
                "round trip failed for {json}"
            );
        }

        assert_eq!(
            serde_json::to_string(&SourceSpec::Constant { value: 0.5 }).unwrap(),
            r#"{"kind":"constant","value":0.5}"#
        );
    }

    /// Every optional field must have a default, so the web app can send the
    /// short form and grow into the long one.
    #[test]
    fn the_optional_request_fields_all_default() {
        let request: SolveRequest = serde_json::from_str(
            r#"{"vertices":[0,0,1,0,0,1],"triangles":[0,1,2],
                "segments":[0,0,1,0],"segment_tags":[0],
                "conditions":[{"kind":"dirichlet","value":0}]}"#,
        )
        .unwrap();

        assert_eq!(request.conductivity, 1.0);
        assert_eq!(request.degree, 1);
        assert_eq!(request.subdivisions, 2);
        assert_eq!(request.max_iterations, 5_000);
        assert_eq!(request.penalty, None);
        assert_eq!(request.source, SourceSpec::Constant { value: 0.0 });
    }
}
