//! Turning a modal solution into something a canvas can fill.
//!
//! The solver's output is Dubiner coefficients, not values: nothing in it can
//! be drawn without first being evaluated somewhere. There is no nodal
//! extraction helper in the solver and there should not be one -- a
//! discontinuous field has no single value at a shared vertex, so any
//! vertex-indexed representation would have to average across elements and
//! quietly smooth away the discontinuities the method exists to represent.
//!
//! Instead each element is sampled on its own barycentric lattice and emitted
//! with its own copy of every point. Adjacent elements duplicate coordinates,
//! which looks wasteful and is exactly right: where the field jumps, the two
//! copies carry different values, and the picture shows the jump.
//!
//! The lattice also does the second job a flat per-element fill cannot. A
//! degree-3 basis is cubic inside each element; one colour per element throws
//! that away and reports a piecewise-constant field, which is not what was
//! solved. Subdividing resolves the curvature at the cost of `n^2` fills.

use fea_dg::mesh::dg_mesh::DgMesh;
use fea_dg::reference::dubiner::Dubiner;
use fea_dg::solver::gradient::{gradient_length, gradient_trace};
use fea_dg::solver::solution::Solution;

/// A field ready to draw: sub-triangles over per-element sample points.
pub struct Sampled {
    /// Interleaved `[x, y]` per sample point, element-major. Point `p` of
    /// element `e` is at `(e * stride + p) * 2`.
    pub positions: Vec<f32>,
    /// The field at each sample point, indexed `e * stride + p`.
    pub values: Vec<f32>,
    /// Corner triples in *local* lattice indices, `0..stride`.
    ///
    /// The lattice is identical on every element, so this is emitted once and
    /// the renderer offsets by `e * stride`. Emitting it per element would
    /// multiply the payload by the element count for no added information.
    pub sub_triangles: Vec<u32>,
    /// Sample points per element, `(n+1)(n+2)/2`.
    pub stride: usize,
    /// Extremes of `values`.
    ///
    /// Taken over what is actually drawn rather than over the polynomials'
    /// true extrema. The legend and the picture then cannot disagree: a
    /// colour at the end of the ramp is a colour that appears on screen.
    pub min: f64,
    pub max: f64,
}

/// The reference basis evaluated once on a lattice, reusable for every element
/// and every frame.
///
/// Split out from [`sample_field`] because a transient run samples the same
/// lattice at every frame. Rebuilding the table per frame would be a few
/// thousand basis evaluations thrown away each time, and the whole point of the
/// frame-at-a-time protocol is that per-frame work stays proportional to the
/// field rather than to the setup.
pub struct LatticeBasis {
    /// `[point][mode]`, flattened.
    basis: Vec<f64>,
    points: Vec<[f64; 2]>,
    n_modes: usize,
}

impl LatticeBasis {
    pub fn new(degree: usize, subdivisions: usize) -> Self {
        let points = lattice_points(subdivisions.max(1));
        let dubiner = Dubiner::new(degree);
        let n_modes = dubiner.len();

        let mut basis = vec![0.0; points.len() * n_modes];
        for (point, &[r, s]) in points.iter().enumerate() {
            dubiner.evaluate(r, s, &mut basis[point * n_modes..(point + 1) * n_modes]);
        }

        LatticeBasis {
            basis,
            points,
            n_modes,
        }
    }

    /// Sample points per element.
    pub fn stride(&self) -> usize {
        self.points.len()
    }

    pub fn points(&self) -> &[[f64; 2]] {
        &self.points
    }

    fn at(&self, point: usize) -> &[f64] {
        &self.basis[point * self.n_modes..(point + 1) * self.n_modes]
    }
}

/// The sample positions alone, which never change once the mesh is fixed.
///
/// Emitted once per run rather than once per frame. At a few thousand elements
/// the positions are the larger half of a frame's payload, and they are the half
/// that is identical every time.
pub fn sample_positions(mesh: &DgMesh, lattice: &LatticeBasis) -> Vec<f32> {
    let mut positions = Vec::with_capacity(mesh.n_elements() * lattice.stride() * 2);
    for element in 0..mesh.n_elements() {
        for &reference in lattice.points() {
            let [x, y] = mesh.map_to_physical(element, reference);
            positions.push(x as f32);
            positions.push(y as f32);
        }
    }
    positions
}

/// Evaluates a scalar derived from an `N`-variable solution into a caller-owned
/// buffer, and returns its extremes.
///
/// Takes the buffer rather than returning one so that a run of sixty frames
/// allocates once. Returns the extremes in `f64` because they are accumulated
/// before the narrowing to `f32`, so a legend cannot disagree with the picture
/// by a rounding.
///
/// A non-finite sample is *reported*, not silently written: a `NaN` reaching the
/// colour scale produces an all-neutral field with no error anywhere, which
/// looks like a solver that returned nothing rather than one that diverged.
pub fn sample_into<const N: usize, F>(
    out: &mut [f32],
    mesh: &DgMesh,
    solution: &Solution<N>,
    lattice: &LatticeBasis,
    derive: F,
) -> Result<(f64, f64), String>
where
    F: Fn(&[f64; N]) -> f64,
{
    let stride = lattice.stride();
    let expected = mesh.n_elements() * stride;
    if out.len() != expected {
        return Err(format!(
            "the sample buffer holds {} values, but this mesh and lattice need {expected}",
            out.len()
        ));
    }

    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;

    for element in 0..mesh.n_elements() {
        for point in 0..stride {
            let state = solution.evaluate_with(element, lattice.at(point));
            let value = derive(&state);
            if !value.is_finite() {
                return Err(format!(
                    "element {element} sampled to a non-finite value; the run has diverged"
                ));
            }
            min = min.min(value);
            max = max.max(value);
            out[element * stride + point] = value as f32;
        }
    }

    Ok((min, max))
}

/// Evaluates a two-component field derived from the solution, interleaved.
///
/// Its own routine rather than two calls to [`sample_into`] so the pair is
/// written interleaved and shares [`sample_positions`]' indexing exactly --
/// which is what lets a renderer add a displacement to a position without a
/// second index map.
///
/// Returns the largest magnitude, which is what an automatic warp scale is
/// computed from: a bracket under a realistic load moves by microns, and drawing
/// that to scale draws nothing.
pub fn sample_vector_into<const N: usize, F>(
    out: &mut [f32],
    mesh: &DgMesh,
    solution: &Solution<N>,
    lattice: &LatticeBasis,
    derive: F,
) -> Result<f64, String>
where
    F: Fn(&[f64; N]) -> [f64; 2],
{
    let stride = lattice.stride();
    let expected = mesh.n_elements() * stride * 2;
    if out.len() != expected {
        return Err(format!(
            "the vector buffer holds {} values, but this mesh and lattice need {expected}",
            out.len()
        ));
    }

    let mut largest = 0.0f64;
    for element in 0..mesh.n_elements() {
        for point in 0..stride {
            let state = solution.evaluate_with(element, lattice.at(point));
            let value = derive(&state);
            if !value[0].is_finite() || !value[1].is_finite() {
                return Err(format!(
                    "element {element} sampled to a non-finite vector; the run has diverged"
                ));
            }
            largest = largest.max(value[0].hypot(value[1]));
            let base = (element * stride + point) * 2;
            out[base] = value[0] as f32;
            out[base + 1] = value[1] as f32;
        }
    }

    Ok(largest)
}

/// Evaluates the LDG-recovered gradient on the display lattice, as the three
/// independent components of the symmetric part.
///
/// The gradient arrives as modal coefficients **in the same Dubiner basis** as
/// the solution, so the lattice table built for one serves the other and no
/// second basis evaluation happens anywhere. That is a property of the LDG
/// auxiliary solve -- `q` is recovered into the discrete space, not
/// differentiated out of it -- and it is why sampling a strain costs the same as
/// sampling a displacement.
///
/// Emitted as `(eps_xx, eps_yy, eps_xy)` with the *tensor* shear rather than as
/// the four gradient entries: the skew part is a rigid rotation and carries no
/// stress, so sending it would be sending a component every consumer must
/// remember to discard.
pub fn sample_strain_into(
    out: &mut [f32],
    mesh: &DgMesh,
    gradient: &[f64],
    n_modes: usize,
    lattice: &LatticeBasis,
) -> Result<(), String> {
    let stride = lattice.stride();
    let expected = mesh.n_elements() * stride * 3;
    if out.len() != expected {
        return Err(format!(
            "the strain buffer holds {} values, but this mesh and lattice need {expected}",
            out.len()
        ));
    }
    let needed = gradient_length::<2>(mesh.n_elements(), n_modes);
    if gradient.len() != needed {
        return Err(format!(
            "the gradient holds {} coefficients, but this mesh and basis need {needed}",
            gradient.len()
        ));
    }

    for element in 0..mesh.n_elements() {
        for point in 0..stride {
            let q = gradient_trace::<2>(gradient, n_modes, element, lattice.at(point));
            let strain = [q[0][0], q[1][1], 0.5 * (q[0][1] + q[1][0])];
            if strain.iter().any(|value| !value.is_finite()) {
                return Err(format!(
                    "element {element} sampled to a non-finite strain; the run has diverged"
                ));
            }
            let base = (element * stride + point) * 3;
            out[base] = strain[0] as f32;
            out[base + 1] = strain[1] as f32;
            out[base + 2] = strain[2] as f32;
        }
    }

    Ok(())
}

/// Sample points per element for a lattice of order `n`.
pub fn lattice_size(n: usize) -> usize {
    (n + 1) * (n + 2) / 2
}

/// Position of lattice point `(i, j)` in the flat ordering.
///
/// Rows run along `j`, and row `j` holds `n + 1 - j` points, so each row starts
/// where the triangular number of the rows above it ends.
pub fn lattice_index(i: usize, j: usize, n: usize) -> usize {
    j * (n + 1) - j * (j.saturating_sub(1)) / 2 + i
}

/// Reference coordinates of the lattice, in flat order.
pub fn lattice_points(n: usize) -> Vec<[f64; 2]> {
    let step = 1.0 / n as f64;
    let mut points = Vec::with_capacity(lattice_size(n));
    for j in 0..=n {
        for i in 0..=(n - j) {
            points.push([i as f64 * step, j as f64 * step]);
        }
    }
    points
}

/// The `n^2` sub-triangles tiling the lattice, as local indices.
///
/// Each cell of the lattice contributes an upward triangle, and every cell but
/// the last of a row also contributes the downward one that completes the
/// rhombus. Corners are emitted counter-clockwise, matching the reference
/// triangle's own winding, so a consumer that cares about orientation -- a VTK
/// writer, say -- gets it for free.
pub fn sub_triangles(n: usize) -> Vec<u32> {
    let mut out = Vec::with_capacity(3 * n * n);
    for j in 0..n {
        for i in 0..(n - j) {
            let at = |i: usize, j: usize| lattice_index(i, j, n) as u32;

            out.extend_from_slice(&[at(i, j), at(i + 1, j), at(i, j + 1)]);
            if i + 1 < n - j {
                out.extend_from_slice(&[at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
            }
        }
    }
    out
}

/// Evaluates `solution` on every element's lattice.
///
/// `subdivisions` is the lattice order `n`; callers are expected to have
/// clamped it to a sane range already.
pub fn sample_field(
    mesh: &DgMesh,
    solution: &Solution<1>,
    degree: usize,
    subdivisions: usize,
) -> Sampled {
    let n = subdivisions.max(1);
    let points = lattice_points(n);
    let stride = points.len();
    let n_modes = solution.n_modes();

    // The reference basis does not depend on the element, so it is built once
    // for the whole mesh rather than per element. At a few thousand elements
    // this is the difference between one basis evaluation per lattice point and
    // several thousand of them.
    let dubiner = Dubiner::new(degree);
    let mut basis = vec![0.0; stride * n_modes];
    for (point, &[r, s]) in points.iter().enumerate() {
        dubiner.evaluate(r, s, &mut basis[point * n_modes..(point + 1) * n_modes]);
    }

    let elements = mesh.n_elements();
    let mut positions = Vec::with_capacity(elements * stride * 2);
    let mut values = Vec::with_capacity(elements * stride);
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;

    for element in 0..elements {
        for (point, &reference) in points.iter().enumerate() {
            let [x, y] = mesh.map_to_physical(element, reference);
            positions.push(x as f32);
            positions.push(y as f32);

            let [value] =
                solution.evaluate_with(element, &basis[point * n_modes..(point + 1) * n_modes]);
            // Accumulated in f64 and narrowed only for transport, so the
            // reported extremes are not themselves a rounding of the field.
            min = min.min(value);
            max = max.max(value);
            values.push(value as f32);
        }
    }

    Sampled {
        positions,
        values,
        sub_triangles: sub_triangles(n),
        stride,
        // A mesh with no elements cannot reach here -- `DgMesh::from_arrays`
        // rejects one -- but an infinite range would poison the legend, so the
        // empty case collapses to a point rather than propagating.
        min: if min.is_finite() { min } else { 0.0 },
        max: if max.is_finite() { max } else { 0.0 },
    }
}

#[cfg(test)]
mod sampling {
    use super::*;
    use fea_dg::reference::element::ReferenceElement;

    /// An off-by-one in the row offsets would still produce a plausible
    /// picture -- slightly wrong colours in slightly wrong places -- which is
    /// the hardest kind of rendering bug to notice. Pin the indexing directly.
    #[test]
    fn the_lattice_index_is_a_bijection() {
        for n in 1..=4 {
            let mut seen = vec![false; lattice_size(n)];
            for j in 0..=n {
                for i in 0..=(n - j) {
                    let index = lattice_index(i, j, n);
                    assert!(index < seen.len(), "n = {n}: ({i}, {j}) -> {index}");
                    assert!(!seen[index], "n = {n}: ({i}, {j}) collided at {index}");
                    seen[index] = true;
                }
            }
            assert!(seen.iter().all(|&hit| hit), "n = {n} left a gap");
        }
    }

    /// `lattice_points` must walk the lattice in the same order `lattice_index`
    /// numbers it, or the basis table and the positions would be permuted
    /// relative to each other.
    #[test]
    fn lattice_points_are_in_index_order() {
        for n in 1..=4 {
            let points = lattice_points(n);
            let step = 1.0 / n as f64;
            for j in 0..=n {
                for i in 0..=(n - j) {
                    let [r, s] = points[lattice_index(i, j, n)];
                    assert!((r - i as f64 * step).abs() < 1e-15);
                    assert!((s - j as f64 * step).abs() < 1e-15);
                }
            }
        }
    }

    /// The sub-triangles must cover the reference triangle exactly: no gaps,
    /// no overlaps, no strays outside it. Area is the cheapest total check, and
    /// consistent winding is asserted alongside because a flipped sub-triangle
    /// has the same absolute area.
    #[test]
    fn sub_triangles_tile_the_reference_triangle() {
        for n in 1..=4 {
            let points = lattice_points(n);
            let triangles = sub_triangles(n);
            assert_eq!(triangles.len(), 3 * n * n, "n = {n}");

            let mut total = 0.0;
            for corners in triangles.chunks_exact(3) {
                let a = points[corners[0] as usize];
                let b = points[corners[1] as usize];
                let c = points[corners[2] as usize];
                let signed =
                    ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0;
                assert!(signed > 0.0, "n = {n}: a sub-triangle is wound clockwise");
                total += signed;
            }
            assert!(
                (total - 0.5).abs() < 1e-12,
                "n = {n}: covered {total} of the reference triangle's 0.5"
            );

            let mut used = vec![false; points.len()];
            for &corner in &triangles {
                used[corner as usize] = true;
            }
            assert!(used.iter().all(|&hit| hit), "n = {n} left a point unused");
        }
    }

    /// The sampler is a loop around `evaluate_with`; this pins that it passes
    /// the right basis slice for the right point, which is the one thing the
    /// loop can get wrong silently.
    #[test]
    fn sampled_values_agree_with_a_direct_evaluation() {
        let mesh = DgMesh::from_arrays(
            &[0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0],
            &[0, 1, 2, 1, 3, 2],
        )
        .unwrap();

        let degree = 2;
        let reference = ReferenceElement::new(degree);
        let solution = Solution::<1>::project(&mesh, &reference, |[x, y]| [x * x + 3.0 * y]);

        let sampled = sample_field(&mesh, &solution, degree, 3);
        let points = lattice_points(3);
        let dubiner = Dubiner::new(degree);
        let mut basis = vec![0.0; solution.n_modes()];

        for element in 0..mesh.n_elements() {
            for (point, &[r, s]) in points.iter().enumerate() {
                dubiner.evaluate(r, s, &mut basis);
                let [expected] = solution.evaluate_with(element, &basis);
                let got = sampled.values[element * sampled.stride + point];
                assert!(
                    (got as f64 - expected).abs() < 1e-5,
                    "element {element} point {point}: {got} vs {expected}"
                );
            }
        }
    }

    /// A quadratic is representable at `p = 2`, so the projection is exact and
    /// the sampled positions and values must satisfy the function they came
    /// from. This catches a `map_to_physical` mix-up, which `evaluate_with`
    /// alone cannot: both would still be self-consistent.
    #[test]
    fn positions_and_values_describe_the_same_function() {
        let mesh = DgMesh::from_arrays(
            &[0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 2.0],
            &[0, 1, 2, 1, 3, 2],
        )
        .unwrap();

        let degree = 2;
        let reference = ReferenceElement::new(degree);
        let field = |[x, y]: [f64; 2]| x * x - 2.0 * y;
        let solution = Solution::<1>::project(&mesh, &reference, |x| [field(x)]);

        let sampled = sample_field(&mesh, &solution, degree, 2);
        for index in 0..sampled.values.len() {
            let x = sampled.positions[index * 2] as f64;
            let y = sampled.positions[index * 2 + 1] as f64;
            let expected = field([x, y]);
            assert!(
                (sampled.values[index] as f64 - expected).abs() < 1e-4,
                "at ({x}, {y}): {} vs {expected}",
                sampled.values[index]
            );
        }
    }

    #[test]
    fn min_and_max_bracket_every_sampled_value() {
        let mesh = DgMesh::from_arrays(
            &[0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0],
            &[0, 1, 2, 1, 3, 2],
        )
        .unwrap();
        let reference = ReferenceElement::new(1);
        let solution = Solution::<1>::project(&mesh, &reference, |[x, y]| [x - y]);

        let sampled = sample_field(&mesh, &solution, 1, 2);
        assert_eq!(sampled.values.len(), mesh.n_elements() * sampled.stride);
        assert_eq!(sampled.positions.len(), sampled.values.len() * 2);

        for &value in &sampled.values {
            assert!(value as f64 >= sampled.min - 1e-9);
            assert!(value as f64 <= sampled.max + 1e-9);
        }
        // The field really does span [-1, 1] over the unit square.
        assert!(sampled.min < -0.9 && sampled.max > 0.9);
    }
}
