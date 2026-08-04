//! Browser-facing surface over the `fea-dg` linear elasticity solver.
//!
//! Structurally a twin of [`crate::solve`], and for the same reasons: the
//! library's API is closure-generic, none of that crosses a JSON boundary, and a
//! panic inside wasm aborts the instance and takes the worker with it, so
//! everything that could reach an assertion is checked in [`validate`] first.
//!
//! Three things differ, and each is a consequence of the physics rather than of
//! the plumbing.
//!
//! ## The response carries ingredients, not a field
//!
//! A diffusion solve returns one scalar per sample point because there is only
//! one thing to draw. A solid has a dozen: displacement magnitude and its
//! components, three strains, three stresses, von Mises, the principal stresses,
//! max shear, strain energy. Returning whichever one the request named would
//! make changing the dropdown a re-solve.
//!
//! So this returns the displacement and the strain -- the two fields everything
//! else is an algebraic function of -- plus the material constants, and the web
//! layer derives the scalar in one pass. Seven floats per sample point against
//! three, in exchange for an instant field switch and for the derivation living
//! in TypeScript where it can be unit-tested without a wasm build.
//!
//! ## The strain comes from the auxiliary solve
//!
//! `LdgOperator::gradient` is a work buffer holding `q` for whatever vector was
//! last applied -- after a steady solve, a conjugate gradient search direction
//! with the boundary data suppressed. Using it would produce stress that is
//! subtly wrong near exactly the supports a user is looking at.
//! [`LdgOperator::recover_gradient`] runs the auxiliary solve against the answer
//! instead, which is where a strain can correctly come from and the only place.
//!
//! ## A part nobody is holding is refused
//!
//! Under pure traction data the operator is singular in three directions: two
//! translations and a rotation. The library can solve that -- see
//! `solve_steady_with_null_space` -- but only if the loads are self-equilibrated
//! in all three, `sum F = 0` and `sum M = 0`, which a person dragging arrows will
//! essentially never satisfy. Conjugate gradient given inconsistent data
//! converges to the least-squares answer without complaint: a plausible-looking
//! field that solves nothing, with no flag on it anywhere.
//!
//! And even when consistent, the rigid part of the displacement is arbitrary, so
//! the deformed shape floats and rotates -- destroying the one picture this study
//! exists to draw. So [`validate_supports`] asks the operator directly, through
//! `annihilates`, and refuses. Asking the operator rather than the condition
//! table matters: a part on rollers has a non-zero `alpha` on every tag, so the
//! table reports a well-posed problem while one translation is entirely free.

use serde::{Deserialize, Serialize};

use fea_dg::mesh::boundary::{BoundaryCondition, Dirichlet, Robin};
use fea_dg::mesh::dg_mesh::DgMesh;
use fea_dg::reference::dubiner::mode_count;
use fea_dg::reference::element::ReferenceElement;
use fea_dg::solver::residual::LdgOperator;
use fea_dg::solver::solution::Solution;
use fea_dg::{roller, solve_steady, LinearElasticity, PlaneState, SteadyOptions, Traction};

use crate::classify::classify_boundary;
use crate::sample::{
    sample_positions, sample_strain_into, sample_vector_into, sub_triangles, LatticeBasis,
};

/// Highest polynomial degree offered.
///
/// One below the diffusion path's. Two variables double the coefficient vector
/// and the auxiliary buffer holds four fields rather than two, so the same wait
/// buys one degree less.
const MAX_DEGREE: usize = 3;

/// Highest display lattice order.
const MAX_SUBDIVISIONS: usize = 4;

/// Ceiling on `elements * modes` -- the coefficient vector **per variable**.
///
/// Half the diffusion path's, since a solid stores two of them and its operator
/// is worse conditioned besides. Phrased per variable because that is the number
/// a reader can compare against a mesh size.
const MAX_DEGREES_OF_FREEDOM: usize = 200_000;

/// Poisson's ratio ceiling.
///
/// The library refuses only `nu >= 0.5`, where `lambda` is infinite. This stops
/// earlier, because the interval just below is not a place a useful answer comes
/// from: `lambda/mu` passes 400, the penalty -- sized from `lambda + 2 mu` --
/// over-penalises shear jumps by that factor, and the iteration count climbs
/// with it. The rate survives, the error constant and the wait do not.
const MAX_POISSON_RATIO: f64 = 0.495;

#[derive(Debug, Deserialize)]
pub struct ElasticRequest {
    /// Interleaved `[x0, y0, ...]` -- exactly `MeshResponse::vertices`.
    pub vertices: Vec<f64>,
    /// Interleaved corner indices -- exactly `MeshResponse::triangles`.
    pub triangles: Vec<u32>,

    /// The edges of the drawn loops, interleaved `[ax, ay, bx, by, ...]`.
    pub segments: Vec<f64>,
    /// One tag per segment, indexing `conditions`.
    pub segment_tags: Vec<u16>,
    /// The condition each tag names, deduplicated by the caller.
    pub conditions: Vec<ElasticConditionSpec>,

    #[serde(default = "default_youngs")]
    pub youngs_modulus: f64,
    #[serde(default = "default_poisson")]
    pub poisson_ratio: f64,
    #[serde(default)]
    pub plane: PlaneStateSpec,
    /// Uniform body force per unit volume, `[bx, by]`. Gravity is `[0, -rho g]`.
    #[serde(default)]
    pub body_force: [f64; 2],

    #[serde(default = "default_degree")]
    pub degree: usize,
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    /// Interface penalty multiplier; `None` takes the solver's own default.
    #[serde(default)]
    pub penalty: Option<f64>,
    #[serde(default = "default_subdivisions")]
    pub subdivisions: usize,
}

fn default_youngs() -> f64 {
    210e9
}
fn default_poisson() -> f64 {
    0.3
}
fn default_degree() -> usize {
    2
}
fn default_tolerance() -> f64 {
    1e-10
}
fn default_max_iterations() -> usize {
    20_000
}
fn default_subdivisions() -> usize {
    2
}

/// Which two-dimensional idealisation applies.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlaneStateSpec {
    /// A slice of a body long in `z`: a dam, a tunnel lining, a long weld.
    #[default]
    Strain,
    /// A sheet thin in `z`: a bracket, a gusset plate, a panel.
    Stress,
}

impl From<PlaneStateSpec> for PlaneState {
    fn from(spec: PlaneStateSpec) -> Self {
        match spec {
            PlaneStateSpec::Strain => PlaneState::Strain,
            PlaneStateSpec::Stress => PlaneState::Stress,
        }
    }
}

/// A support or a load, as the UI states it.
///
/// Stated in the units a person uses -- a traction is a traction, not its
/// negation -- because the library's `Traction` already carries the `J . n = -t`
/// conversion. Nothing here builds `Neumann` directly, for the same reason
/// nothing in [`crate::solve`] builds `Robin::new`.
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ElasticConditionSpec {
    /// Clamped: `u = 0`, both components.
    Fixed,
    /// Prescribed displacement `u = (x, y)`.
    Displacement { x: f64, y: f64 },
    /// A traction-free surface. The default state of any edge nobody loaded.
    Free,
    /// Distributed traction `t = (x, y)`, per unit length of boundary.
    Traction { x: f64, y: f64 },
    /// A total force `(x, y)` spread evenly over a boundary of length `length`.
    ///
    /// A genuine point load is not offered, and the omission is deliberate: in
    /// two-dimensional elasticity a concentrated force has a logarithmically
    /// singular displacement and a stress that does not converge under
    /// refinement, so the peak stress on screen would grow every time the mesh
    /// was refined and never settle. Spreading a known resultant over a known
    /// length is well posed, converges, and localises as far as wanted by
    /// drawing a shorter edge.
    Force { x: f64, y: f64, length: f64 },
    /// A roller holding `u_x` and leaving the `y` traction free -- the support
    /// for a **vertical** edge. Correct only on an edge square to the axes.
    RollerX,
    /// A roller holding `u_y`, for a **horizontal** edge.
    RollerY,
    /// An elastic foundation: `t = -stiffness * u`, with `stiffness > 0`.
    Spring { stiffness: f64 },
}

impl ElasticConditionSpec {
    /// Whether this condition constrains displacement at all.
    ///
    /// Used only for the error message. Whether the *problem* is constrained is
    /// decided by asking the operator, because per-variable conditions make the
    /// table an unreliable witness.
    fn holds_displacement(&self) -> bool {
        !matches!(
            self,
            ElasticConditionSpec::Free
                | ElasticConditionSpec::Traction { .. }
                | ElasticConditionSpec::Force { .. }
        )
    }
}

#[derive(Debug, Serialize)]
pub struct ElasticResponse {
    /// Interleaved `[x, y]` per sample point, element-major, **undeformed**.
    ///
    /// The deformation is sent separately so the exaggeration slider is a
    /// render-time multiply rather than a buffer rebuild.
    pub positions: Vec<f32>,
    /// Interleaved `[ux, uy]` per sample point, sharing `positions`' indexing.
    pub displacements: Vec<f32>,
    /// `[eps_xx, eps_yy, eps_xy]` per sample point, with the *tensor* shear
    /// (half the engineering `gamma_xy`).
    pub strains: Vec<f32>,
    /// Sub-triangle corners as local lattice indices, shared by every element.
    pub sub_triangles: Vec<u32>,
    pub sample_stride: usize,
    pub subdivisions: usize,

    pub element_count: usize,
    pub mode_count: usize,
    pub degree: usize,

    /// The effective first Lame parameter -- already carrying the plane-stress
    /// substitution -- so the web layer derives stress without re-deriving it.
    pub lambda: f64,
    pub mu: f64,
    pub poisson_ratio: f64,
    pub plane: PlaneStateSpec,

    /// Largest displacement magnitude over the samples, and the bounding-box
    /// diagonal of the part. Together they set an exaggeration that opens the
    /// deformation to a readable size: a steel bracket under a realistic load
    /// moves by microns, and drawing that to scale draws nothing.
    pub largest_displacement: f64,
    pub extent: f64,

    pub iterations: usize,
    pub residual_norm: f64,
    pub initial_norm: f64,
    /// False when the iteration hit its cap. The field is still returned -- it
    /// is the best iterate -- but it does not solve the problem to tolerance.
    pub converged: bool,

    /// Boundary faces no segment claimed. Nonzero means the supports and loads
    /// near them are not the ones that were asked for.
    pub unclassified_faces: usize,
    /// Largest accepted face-to-segment distance, relative to the mesh diameter.
    pub worst_match_distance: f64,
}

/// A boundary condition whose value function is boxed.
///
/// The library's types are generic over the closure, and every closure has its
/// own anonymous type, so a runtime-sized `Vec` of them cannot be built
/// directly. Boxing keeps the library's own types -- and with them the sign
/// conventions -- rather than re-deriving `alpha` and `beta` here.
type ValueFn = Box<dyn Fn([f64; 2], [f64; 2], f64) -> [f64; 2]>;

enum OwnedElasticCondition {
    Displacement(Dirichlet<ValueFn>),
    Traction(Traction<ValueFn>),
    Mixed(Robin<ValueFn, 2>),
}

impl BoundaryCondition<2> for OwnedElasticCondition {
    fn coefficients(&self) -> ([f64; 2], [f64; 2]) {
        match self {
            OwnedElasticCondition::Displacement(condition) => condition.coefficients(),
            OwnedElasticCondition::Traction(condition) => condition.coefficients(),
            OwnedElasticCondition::Mixed(condition) => condition.coefficients(),
        }
    }

    fn value(&self, x: [f64; 2], normal: [f64; 2], t: f64) -> [f64; 2] {
        match self {
            OwnedElasticCondition::Displacement(condition) => condition.value(x, normal, t),
            OwnedElasticCondition::Traction(condition) => condition.value(x, normal, t),
            OwnedElasticCondition::Mixed(condition) => condition.value(x, normal, t),
        }
    }
}

fn build_condition(spec: &ElasticConditionSpec) -> OwnedElasticCondition {
    let zero = || Box::new(|_: [f64; 2], _: [f64; 2], _: f64| [0.0, 0.0]) as ValueFn;

    match *spec {
        ElasticConditionSpec::Fixed => {
            OwnedElasticCondition::Displacement(Dirichlet(zero()))
        }
        ElasticConditionSpec::Displacement { x, y } => OwnedElasticCondition::Displacement(
            Dirichlet(Box::new(move |_, _, _| [x, y]) as ValueFn),
        ),
        ElasticConditionSpec::Free => OwnedElasticCondition::Traction(Traction(zero())),
        ElasticConditionSpec::Traction { x, y } => {
            OwnedElasticCondition::Traction(Traction(Box::new(move |_, _, _| [x, y]) as ValueFn))
        }
        ElasticConditionSpec::Force { x, y, length } => {
            // A resultant becomes a traction by dividing by the length it acts
            // over, which `validate` has already established is positive.
            let traction = [x / length, y / length];
            OwnedElasticCondition::Traction(Traction(
                Box::new(move |_, _, _| traction) as ValueFn
            ))
        }
        ElasticConditionSpec::RollerX | ElasticConditionSpec::RollerY => {
            let held = usize::from(matches!(spec, ElasticConditionSpec::RollerY));
            // Coefficients taken from the library's own `roller` rather than
            // written out again here: which component a roller holds is its
            // definition, and a second copy of it is a second place to get the
            // per-variable mixing backwards.
            let (alpha, beta) = roller(held).coefficients();
            OwnedElasticCondition::Mixed(Robin::new(alpha, beta, zero()))
        }
        ElasticConditionSpec::Spring { stiffness } => OwnedElasticCondition::Mixed(
            Robin::absorbing([stiffness, stiffness], zero()),
        ),
    }
}

/// Everything that could otherwise reach an assertion inside the solver, or
/// leave it running without bound.
fn validate(request: &ElasticRequest) -> Result<(), String> {
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

    // Unmatched faces fall back to tag 0, so tag 0 must exist even when no
    // segment names it.
    if request.conditions.is_empty() {
        return Err("no supports or loads were supplied".into());
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
            ElasticConditionSpec::Fixed | ElasticConditionSpec::Free
            | ElasticConditionSpec::RollerX | ElasticConditionSpec::RollerY => {}
            ElasticConditionSpec::Displacement { x, y }
            | ElasticConditionSpec::Traction { x, y } => {
                if !x.is_finite() || !y.is_finite() {
                    return Err("a support or load has a non-finite value".into());
                }
            }
            ElasticConditionSpec::Force { x, y, length } => {
                if !x.is_finite() || !y.is_finite() {
                    return Err("a force has a non-finite value".into());
                }
                if !(length > 0.0) || !length.is_finite() {
                    return Err(format!(
                        "a total force must be spread over a positive length; got {length}"
                    ));
                }
            }
            ElasticConditionSpec::Spring { stiffness } => {
                // `Robin::absorbing` asserts this. A non-positive stiffness is
                // the anti-dissipative case, which makes the operator indefinite
                // and conjugate gradient meaningless.
                if !(stiffness > 0.0) || !stiffness.is_finite() {
                    return Err(format!(
                        "a foundation stiffness must be positive; got {stiffness}"
                    ));
                }
            }
        }
    }

    // `LinearElasticity::from_youngs` asserts both of these.
    if !(request.youngs_modulus > 0.0) || !request.youngs_modulus.is_finite() {
        return Err(format!(
            "Young's modulus must be positive; got {}",
            request.youngs_modulus
        ));
    }
    if !request.poisson_ratio.is_finite()
        || request.poisson_ratio <= -1.0
        || request.poisson_ratio > MAX_POISSON_RATIO
    {
        return Err(format!(
            "Poisson's ratio must lie between -1 and {MAX_POISSON_RATIO}; got {}. \
             Approaching 0.5 the material is incompressible, which this formulation \
             does not handle.",
            request.poisson_ratio
        ));
    }
    if request.body_force.iter().any(|value| !value.is_finite()) {
        return Err("the body force is not finite".into());
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
    // Stricter than the library, which allows zero. For the scalar Laplacian the
    // alternating LDG flux is coercive with no penalty at all; the elastic
    // argument runs through `sym`, which piecewise-rigid fields annihilate, so a
    // zero penalty leaves a null space that has nothing to do with the supports.
    if let Some(penalty) = request.penalty {
        if !(penalty > 0.0) || !penalty.is_finite() {
            return Err(format!(
                "the interface penalty must be positive for a solid; got {penalty}"
            ));
        }
    }

    let elements = request.triangles.len() / 3;
    let unknowns = elements.saturating_mul(mode_count(request.degree));
    if unknowns > MAX_DEGREES_OF_FREEDOM {
        return Err(format!(
            "this problem has {unknowns} unknowns per displacement component, above the \
             {MAX_DEGREES_OF_FREEDOM} ceiling. Use a larger maximum element area, or a \
             lower polynomial degree."
        ));
    }

    Ok(())
}

/// Refuses a part that is free to move without deforming.
///
/// Asks the operator, not the condition table. A part on rollers has a non-zero
/// `alpha` on every tag -- so the table says it is held -- while the direction
/// the rollers let it slide in is entirely unconstrained. Three operator
/// applications against the thousands a solve takes.
fn validate_supports<E: fea_dg::Equation<2>>(
    operator: &mut LdgOperator<'_, 2, E>,
    mesh: &DgMesh,
    reference: &ReferenceElement,
    conditions: &[ElasticConditionSpec],
) -> Result<(), String> {
    let modes = [
        ("slide sideways", Solution::<2>::project(mesh, reference, |_| [1.0, 0.0])),
        ("slide up and down", Solution::<2>::project(mesh, reference, |_| [0.0, 1.0])),
        ("rotate", Solution::<2>::project(mesh, reference, |[x, y]| [-y, x])),
    ];

    for (motion, mode) in modes {
        if operator.annihilates(mode.coefficients()) {
            let hint = if conditions.iter().any(|c| c.holds_displacement()) {
                "The supports it has leave that motion free -- rollers only hold one \
                 direction each."
            } else {
                "Nothing is holding it."
            };
            return Err(format!(
                "This part is free to {motion} without deforming, so the stress in it is \
                 not determined. {hint} Fix an edge, or add a roller in the missing \
                 direction."
            ));
        }
    }

    Ok(())
}

/// The bounding-box diagonal of the mesh, which sets the scale a deformation is
/// exaggerated against.
fn extent_of(vertices: &[f64]) -> f64 {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for point in vertices.chunks_exact(2) {
        for axis in 0..2 {
            min[axis] = min[axis].min(point[axis]);
            max[axis] = max[axis].max(point[axis]);
        }
    }
    (max[0] - min[0]).hypot(max[1] - min[1])
}

/// Solves a linear elastostatic problem and samples the answer for display.
///
/// Pure: no state is retained between calls.
pub fn solve_elastic_problem(request: ElasticRequest) -> Result<ElasticResponse, String> {
    validate(&request)?;

    // Declaration order below is the lifetime contract: `operator` borrows from
    // everything above it, and Rust drops locals in reverse order.
    let mesh = DgMesh::from_arrays(&request.vertices, &request.triangles)
        .map_err(|error| format!("the mesh cannot be solved on: {error}"))?;

    let reference = ReferenceElement::new(request.degree);
    let body_force = request.body_force;
    let equation = LinearElasticity::from_youngs(
        request.youngs_modulus,
        request.poisson_ratio,
        request.plane.into(),
        move |_| body_force,
    );

    let owned: Vec<OwnedElasticCondition> =
        request.conditions.iter().map(build_condition).collect();

    // Tag 0 is the fallback for a face no segment claims; `validate` has already
    // established that it exists.
    let classification = classify_boundary(&mesh, &request.segments, &request.segment_tags, 0);

    let conditions: Vec<&dyn BoundaryCondition<2>> = owned
        .iter()
        .map(|condition| condition as &dyn BoundaryCondition<2>)
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

    validate_supports(&mut operator, &mesh, &reference, &request.conditions)?;

    let options = SteadyOptions {
        tolerance: request.tolerance,
        max_iterations: request.max_iterations,
        preconditioned: true,
    };
    let (solution, report) = solve_steady(&mut operator, &options);

    let lattice = LatticeBasis::new(request.degree, request.subdivisions);
    let stride = lattice.stride();
    let samples = mesh.n_elements() * stride;

    let mut displacements = vec![0.0f32; samples * 2];
    let largest_displacement =
        sample_vector_into(&mut displacements, &mesh, &solution, &lattice, |u| *u)?;

    let gradient = operator.recover_gradient(solution.coefficients()).to_vec();
    let mut strains = vec![0.0f32; samples * 3];
    sample_strain_into(
        &mut strains,
        &mesh,
        &gradient,
        reference.n_modes(),
        &lattice,
    )?;

    Ok(ElasticResponse {
        positions: sample_positions(&mesh, &lattice),
        displacements,
        strains,
        sub_triangles: sub_triangles(request.subdivisions.max(1)),
        sample_stride: stride,
        subdivisions: request.subdivisions,
        element_count: mesh.n_elements(),
        mode_count: reference.n_modes(),
        degree: request.degree,
        lambda: equation.lambda,
        mu: equation.mu,
        poisson_ratio: request.poisson_ratio,
        plane: request.plane,
        largest_displacement,
        extent: extent_of(&request.vertices),
        iterations: report.iterations,
        residual_norm: report.residual_norm,
        initial_norm: report.initial_norm,
        converged: report.converged,
        unclassified_faces: classification.unclassified,
        worst_match_distance: classification.worst_relative_distance,
    })
}

#[cfg(test)]
mod fixtures {
    use super::*;
    use crate::{build_mesh, MeshRequest};

    /// A rectangle `length` by `depth`, meshed, with one tag per side:
    /// 0 = left, 1 = right, 2 = bottom, 3 = top.
    pub fn plate(length: f64, depth: f64, max_area: f64) -> ElasticRequest {
        let outline = vec![
            [0.0, 0.0],
            [length, 0.0],
            [length, depth],
            [0.0, depth],
        ];
        let mesh = build_mesh(MeshRequest {
            boundary: outline.clone(),
            holes: Vec::new(),
            min_angle_deg: 25.0,
            max_area: Some(max_area),
            max_steps: None,
            max_triangles: None,
        })
        .expect("the plate meshes");

        let mut segments = Vec::new();
        for index in 0..outline.len() {
            let a = outline[index];
            let b = outline[(index + 1) % outline.len()];
            segments.extend_from_slice(&[a[0], a[1], b[0], b[1]]);
        }
        // The outline is listed counter-clockwise from the origin, so its edges
        // are bottom, right, top, left in that order.
        let segment_tags = vec![2, 1, 3, 0];

        ElasticRequest {
            vertices: mesh.vertices,
            triangles: mesh.triangles,
            segments,
            segment_tags,
            conditions: vec![
                ElasticConditionSpec::Fixed,
                ElasticConditionSpec::Free,
                ElasticConditionSpec::Free,
                ElasticConditionSpec::Free,
            ],
            youngs_modulus: 1000.0,
            poisson_ratio: 0.3,
            plane: PlaneStateSpec::Stress,
            body_force: [0.0, 0.0],
            degree: 2,
            tolerance: 1e-10,
            max_iterations: 20_000,
            penalty: None,
            subdivisions: 2,
        }
    }

    /// Peak von Mises stress over the samples, derived the way the web layer
    /// will, so the two cannot drift apart unnoticed.
    pub fn peak_von_mises(response: &ElasticResponse) -> f64 {
        let mut peak = 0.0f64;
        for strain in response.strains.chunks_exact(3) {
            let (exx, eyy, exy) = (strain[0] as f64, strain[1] as f64, strain[2] as f64);
            let dilatation = response.lambda * (exx + eyy);
            let sxx = dilatation + 2.0 * response.mu * exx;
            let syy = dilatation + 2.0 * response.mu * eyy;
            let sxy = 2.0 * response.mu * exy;
            let szz = match response.plane {
                PlaneStateSpec::Stress => 0.0,
                PlaneStateSpec::Strain => response.poisson_ratio * (sxx + syy),
            };
            let vm = (((sxx - syy).powi(2) + (syy - szz).powi(2) + (szz - sxx).powi(2)) / 2.0
                + 3.0 * sxy * sxy)
                .sqrt();
            peak = peak.max(vm);
        }
        peak
    }
}

#[cfg(test)]
mod steady_solve {
    use super::fixtures::*;
    use super::*;

    /// A cantilever clamped at the left and pulled down at the right, which is
    /// the shape of every request the UI will send.
    fn cantilever(load: f64) -> ElasticRequest {
        let mut request = plate(4.0, 0.5, 0.02);
        request.conditions[1] = ElasticConditionSpec::Force {
            x: 0.0,
            y: -load,
            length: 0.5,
        };
        request
    }

    #[test]
    fn a_cantilever_deflects_close_to_beam_theory() {
        let response = solve_elastic_problem(cantilever(1.0)).expect("it solves");
        assert!(response.converged, "{} iterations", response.iterations);
        assert_eq!(response.unclassified_faces, 0);

        // P L^3 / (3 E I) with I = depth^3 / 12.
        let second_moment: f64 = 0.5f64.powi(3) / 12.0;
        let bernoulli = 1.0 * 4.0f64.powi(3) / (3.0 * 1000.0 * second_moment);

        // The peak displacement is at the tip. A pointwise clamp is stiffer than
        // the classical end condition and shear makes it softer, so the two
        // corrections pull in opposite directions -- hence a bracket rather than
        // a number.
        assert!(
            response.largest_displacement > 0.7 * bernoulli
                && response.largest_displacement < 1.4 * bernoulli,
            "tip deflection {} against Euler-Bernoulli {bernoulli}",
            response.largest_displacement
        );
    }

    #[test]
    fn the_response_is_linear_in_the_load() {
        let single = solve_elastic_problem(cantilever(1.0)).expect("it solves");
        let double = solve_elastic_problem(cantilever(2.0)).expect("it solves");

        let ratio = double.largest_displacement / single.largest_displacement;
        assert!(
            (ratio - 2.0).abs() < 1e-6,
            "doubling the load scaled the deflection by {ratio}"
        );
        let stress_ratio = peak_von_mises(&double) / peak_von_mises(&single);
        assert!(
            (stress_ratio - 2.0).abs() < 1e-6,
            "doubling the load scaled the peak stress by {stress_ratio}"
        );
    }

    /// A total force divided by the length it acts over is a traction, and the
    /// two ways of saying it must give the same answer. This pins the conversion
    /// the wire format performs.
    #[test]
    fn a_total_force_equals_the_traction_it_spreads_to() {
        let by_force = solve_elastic_problem(cantilever(1.0)).expect("it solves");

        let mut request = plate(4.0, 0.5, 0.02);
        request.conditions[1] = ElasticConditionSpec::Traction {
            x: 0.0,
            y: -1.0 / 0.5,
        };
        let by_traction = solve_elastic_problem(request).expect("it solves");

        let difference =
            (by_force.largest_displacement - by_traction.largest_displacement).abs();
        assert!(
            difference < 1e-9 * by_force.largest_displacement,
            "{} against {}",
            by_force.largest_displacement,
            by_traction.largest_displacement
        );
    }

    /// The two idealisations are different materials and must give different
    /// answers. A plane-stress plate is more compliant, so it deflects further.
    #[test]
    fn the_plane_state_changes_the_answer() {
        let mut stress = cantilever(1.0);
        stress.plane = PlaneStateSpec::Stress;
        let mut strain = cantilever(1.0);
        strain.plane = PlaneStateSpec::Strain;

        let soft = solve_elastic_problem(stress).expect("it solves");
        let stiff = solve_elastic_problem(strain).expect("it solves");

        assert!(soft.lambda < stiff.lambda);
        assert_eq!(soft.mu, stiff.mu, "the shear modulus is the same in both");
        assert!(
            soft.largest_displacement > stiff.largest_displacement,
            "plane stress {} should exceed plane strain {}",
            soft.largest_displacement,
            stiff.largest_displacement
        );
    }

    /// Gravity alone, with no edge load, must still deflect the part. It is the
    /// only path that exercises the source term, and a body force dropped on the
    /// floor would leave every traction-driven test passing.
    #[test]
    fn a_body_force_alone_deflects_the_part() {
        let mut request = plate(4.0, 0.5, 0.02);
        request.body_force = [0.0, -10.0];
        let response = solve_elastic_problem(request).expect("it solves");

        assert!(response.converged);
        assert!(
            response.largest_displacement > 0.0,
            "gravity produced no displacement at all"
        );

        // And it must point downward: the sign of the source is the one place a
        // stray minus survives every symmetry check.
        let mut lowest = 0.0f64;
        for pair in response.displacements.chunks_exact(2) {
            lowest = lowest.min(pair[1] as f64);
        }
        assert!(lowest < 0.0, "gravity pushed the part upward");
    }

    /// Rollers on both vertical sides hold `u_x` and nothing else, so the part
    /// can still slide vertically. The condition table cannot see that; the
    /// operator can, and the refusal must name the missing direction.
    #[test]
    fn a_part_that_can_still_slide_is_refused() {
        let mut request = plate(4.0, 0.5, 0.02);
        request.conditions[0] = ElasticConditionSpec::RollerX;
        request.conditions[1] = ElasticConditionSpec::RollerX;

        let error = solve_elastic_problem(request).expect_err("it must be refused");
        assert!(error.contains("slide up and down"), "{error}");
        assert!(error.contains("roller"), "{error}");
    }

    #[test]
    fn a_part_held_by_nothing_is_refused() {
        let request = {
            let mut request = plate(4.0, 0.5, 0.02);
            request.conditions[0] = ElasticConditionSpec::Free;
            request
        };
        let error = solve_elastic_problem(request).expect_err("it must be refused");
        assert!(error.contains("Nothing is holding it"), "{error}");
    }

    /// Rollers on two perpendicular sides hold every rigid motion between them,
    /// including the rotation -- so this must be accepted where the pair above
    /// was refused.
    #[test]
    fn perpendicular_rollers_hold_the_part() {
        let mut request = plate(4.0, 0.5, 0.02);
        request.conditions[0] = ElasticConditionSpec::RollerX;
        request.conditions[2] = ElasticConditionSpec::RollerY;
        request.conditions[1] = ElasticConditionSpec::Traction { x: 1.0, y: 0.0 };

        let response = solve_elastic_problem(request).expect("perpendicular rollers hold it");
        assert!(response.converged);
    }

    /// An elastic foundation holds the part without pinning it exactly, and is
    /// the only condition that reaches `Robin::absorbing`.
    #[test]
    fn a_spring_foundation_holds_the_part() {
        let mut request = plate(4.0, 0.5, 0.02);
        request.conditions[0] = ElasticConditionSpec::Spring { stiffness: 5000.0 };
        request.conditions[1] = ElasticConditionSpec::Traction { x: 10.0, y: 0.0 };

        let response = solve_elastic_problem(request).expect("a spring holds it");
        assert!(response.converged);
        assert!(response.largest_displacement > 0.0);
    }

    /// Every buffer must agree about how many sample points there are, or the
    /// renderer indexes one array with another's stride.
    #[test]
    fn the_sample_buffers_are_all_the_same_length() {
        let response = solve_elastic_problem(cantilever(1.0)).expect("it solves");
        let samples = response.element_count * response.sample_stride;

        assert_eq!(response.positions.len(), samples * 2);
        assert_eq!(response.displacements.len(), samples * 2);
        assert_eq!(response.strains.len(), samples * 3);
        assert_eq!(
            response.sub_triangles.len() % 3,
            0,
            "sub-triangles come in corner triples"
        );
        assert!(response.extent > 0.0);
    }

    /// A uniform stretch has a uniform strain, which is the cheapest check that
    /// the strain the response carries is the strain of the field it solved for
    /// -- and not, say, the auxiliary variable of a search direction.
    #[test]
    fn a_uniformly_stretched_plate_reports_a_uniform_strain() {
        const PULL: f64 = 3.0;
        let mut request = plate(2.0, 1.0, 0.02);
        request.conditions[0] = ElasticConditionSpec::RollerX;
        request.conditions[2] = ElasticConditionSpec::RollerY;
        request.conditions[1] = ElasticConditionSpec::Traction { x: PULL, y: 0.0 };
        request.plane = PlaneStateSpec::Stress;

        let response = solve_elastic_problem(request).expect("it solves");
        assert!(response.converged);

        // Uniaxial plane stress: eps_xx = sigma / E, eps_yy = -nu eps_xx.
        let expected_xx = PULL / 1000.0;
        let expected_yy = -0.3 * expected_xx;

        for strain in response.strains.chunks_exact(3) {
            assert!(
                (strain[0] as f64 - expected_xx).abs() < 1e-9,
                "eps_xx {} against {expected_xx}",
                strain[0]
            );
            assert!(
                (strain[1] as f64 - expected_yy).abs() < 1e-9,
                "eps_yy {} against {expected_yy}",
                strain[1]
            );
            assert!((strain[2] as f64).abs() < 1e-9, "eps_xy {}", strain[2]);
        }

        // And the von Mises stress of a uniaxial state is the stress itself.
        assert!((peak_von_mises(&response) - PULL).abs() < 1e-6);
    }
}

#[cfg(test)]
mod rejected_requests {
    use super::fixtures::*;
    use super::*;

    fn rejected(mutate: impl FnOnce(&mut ElasticRequest)) -> String {
        let mut request = plate(2.0, 1.0, 0.05);
        request.conditions[1] = ElasticConditionSpec::Traction { x: 1.0, y: 0.0 };
        mutate(&mut request);
        solve_elastic_problem(request).expect_err("the request should be refused")
    }

    #[test]
    fn a_non_positive_modulus_is_refused_rather_than_panicking() {
        assert!(rejected(|r| r.youngs_modulus = 0.0).contains("Young's modulus"));
        assert!(rejected(|r| r.youngs_modulus = f64::NAN).contains("Young's modulus"));
    }

    #[test]
    fn an_incompressible_ratio_is_refused_before_the_library_asserts() {
        let message = rejected(|r| r.poisson_ratio = 0.5);
        assert!(message.contains("Poisson"), "{message}");
        assert!(message.contains("incompressible"), "{message}");
        // And the ceiling bites before the library's own does.
        assert!(rejected(|r| r.poisson_ratio = 0.499).contains("Poisson"));
    }

    #[test]
    fn a_zero_penalty_is_refused_even_though_the_library_allows_it() {
        let message = rejected(|r| r.penalty = Some(0.0));
        assert!(message.contains("penalty"), "{message}");
    }

    #[test]
    fn a_non_positive_spring_is_refused_before_robin_asserts() {
        let message = rejected(|r| r.conditions[0] = ElasticConditionSpec::Spring {
            stiffness: -1.0,
        });
        assert!(message.contains("stiffness"), "{message}");
    }

    #[test]
    fn a_force_spread_over_nothing_is_refused() {
        let message = rejected(|r| {
            r.conditions[1] = ElasticConditionSpec::Force {
                x: 1.0,
                y: 0.0,
                length: 0.0,
            }
        });
        assert!(message.contains("positive length"), "{message}");
    }

    #[test]
    fn an_out_of_range_degree_is_refused() {
        assert!(rejected(|r| r.degree = 0).contains("degree"));
        assert!(rejected(|r| r.degree = MAX_DEGREE + 1).contains("degree"));
    }

    #[test]
    fn a_tag_with_no_condition_is_refused() {
        let message = rejected(|r| r.segment_tags[0] = 99);
        assert!(message.contains("tagged 99"), "{message}");
    }

    #[test]
    fn an_empty_mesh_is_refused() {
        assert!(rejected(|r| r.triangles.clear()).contains("no mesh"));
    }

    #[test]
    fn a_non_finite_body_force_is_refused() {
        assert!(rejected(|r| r.body_force = [0.0, f64::INFINITY]).contains("body force"));
    }
}

#[cfg(test)]
mod wire_format {
    use super::*;

    /// The shapes the web app emits, pinned against what serde accepts. A
    /// rename here and a rename there is the one change that breaks nothing at
    /// compile time and everything at run time.
    #[test]
    fn the_condition_variants_round_trip_through_json() {
        let cases = [
            (r#"{"kind":"fixed"}"#, ElasticConditionSpec::Fixed),
            (
                r#"{"kind":"displacement","x":1.0,"y":-2.0}"#,
                ElasticConditionSpec::Displacement { x: 1.0, y: -2.0 },
            ),
            (r#"{"kind":"free"}"#, ElasticConditionSpec::Free),
            (
                r#"{"kind":"traction","x":0.0,"y":-5.0}"#,
                ElasticConditionSpec::Traction { x: 0.0, y: -5.0 },
            ),
            (
                r#"{"kind":"force","x":0.0,"y":-100.0,"length":0.25}"#,
                ElasticConditionSpec::Force {
                    x: 0.0,
                    y: -100.0,
                    length: 0.25,
                },
            ),
            (r#"{"kind":"roller_x"}"#, ElasticConditionSpec::RollerX),
            (r#"{"kind":"roller_y"}"#, ElasticConditionSpec::RollerY),
            (
                r#"{"kind":"spring","stiffness":42.0}"#,
                ElasticConditionSpec::Spring { stiffness: 42.0 },
            ),
        ];

        for (json, expected) in cases {
            let parsed: ElasticConditionSpec =
                serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"));
            assert_eq!(parsed, expected, "{json}");
            assert_eq!(serde_json::to_string(&expected).unwrap(), json);
        }
    }

    #[test]
    fn the_plane_state_round_trips() {
        assert_eq!(
            serde_json::from_str::<PlaneStateSpec>(r#""strain""#).unwrap(),
            PlaneStateSpec::Strain
        );
        assert_eq!(
            serde_json::from_str::<PlaneStateSpec>(r#""stress""#).unwrap(),
            PlaneStateSpec::Stress
        );
        assert_eq!(
            serde_json::to_string(&PlaneStateSpec::Stress).unwrap(),
            r#""stress""#
        );
    }

    /// Everything but the mesh and the conditions has a default, so the web
    /// layer can omit a knob it has not built a control for yet.
    #[test]
    fn the_optional_fields_default() {
        let request: ElasticRequest = serde_json::from_str(
            r#"{"vertices":[0,0,1,0,0,1],"triangles":[0,1,2],
                "segments":[],"segment_tags":[],"conditions":[{"kind":"fixed"}]}"#,
        )
        .expect("a minimal request parses");

        assert_eq!(request.poisson_ratio, 0.3);
        assert_eq!(request.plane, PlaneStateSpec::Strain);
        assert_eq!(request.body_force, [0.0, 0.0]);
        assert_eq!(request.degree, 2);
        assert_eq!(request.penalty, None);
    }
}
