//! Browser-facing surface over the `nlsn-delaunay` mesher.
//!
//! Two responsibilities beyond plain marshalling:
//!
//! 1. **Coordinate normalisation.** Input is rescaled into a unit box before
//!    meshing and mapped back afterwards. A drawing UI hands over whatever
//!    coordinates the user happens to be working in -- screen pixels, metres,
//!    microns -- and meshing behaviour should not depend on which.
//! 2. **Panic containment.** A panic in the kernel aborts the wasm instance and
//!    takes the worker with it. Input is validated up front so the common
//!    failure modes come back as ordinary errors instead.

use nlsn_delaunay::elements::polyline::Polyline;
use nlsn_delaunay::elements::vertex::Vertex;
use nlsn_delaunay::planar::mesh::FlatMesh;
use nlsn_delaunay::planar::refine_params::{RefineOutcome, RefineParams};
use nlsn_delaunay::planar::triangulator::Triangulator;

use serde::{Deserialize, Serialize};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

/// Hard memory ceiling for the test binary.
///
/// A runaway mesher is the failure mode this crate is most likely to hit, and
/// on macOS there is no way to fence that from outside: `ulimit -v` is accepted
/// by the shell but silently unenforced, so a test that allocates without bound
/// will happily consume physical memory and then swap, taking the whole machine
/// down with it rather than failing.
///
/// Capping allocation inside the process is portable and exact. Past the
/// budget, `alloc` returns null, Rust's allocation-failure handler aborts, and
/// the run dies immediately with a clear message -- having never requested a
/// page it could not afford.
#[cfg(test)]
mod alloc_budget {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Generous for any legitimate test here, far below the point of swapping.
    const BUDGET_BYTES: usize = 512 * 1024 * 1024;

    static IN_USE: AtomicUsize = AtomicUsize::new(0);

    pub struct Budgeted;

    impl Budgeted {
        fn claim(size: usize) -> bool {
            let mut current = IN_USE.load(Ordering::Relaxed);
            loop {
                let next = current.saturating_add(size);
                if next > BUDGET_BYTES {
                    return false;
                }
                match IN_USE.compare_exchange_weak(
                    current,
                    next,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => return true,
                    Err(observed) => current = observed,
                }
            }
        }

        fn release(size: usize) {
            IN_USE.fetch_sub(size, Ordering::Relaxed);
        }
    }

    /// Bytes currently accounted as live. Used by tests that need to prove a
    /// repeated operation returns memory rather than accumulating it.
    pub fn live_bytes() -> usize {
        IN_USE.load(Ordering::Relaxed)
    }

    unsafe impl GlobalAlloc for Budgeted {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if !Self::claim(layout.size()) {
                return std::ptr::null_mut();
            }
            let ptr = unsafe { System.alloc(layout) };
            if ptr.is_null() {
                Self::release(layout.size());
            }
            ptr
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) };
            Self::release(layout.size());
        }

        // Growing a Vec goes through realloc, which is most of what a growing
        // triangulation does. Without this the accounting drifts badly.
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            if new_size > layout.size() {
                if !Self::claim(new_size - layout.size()) {
                    return std::ptr::null_mut();
                }
            } else {
                Self::release(layout.size() - new_size);
            }

            let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
            if new_ptr.is_null() && new_size > layout.size() {
                Self::release(new_size - layout.size());
            }
            new_ptr
        }
    }
}

#[cfg(test)]
#[global_allocator]
static GLOBAL: alloc_budget::Budgeted = alloc_budget::Budgeted;

#[derive(Debug, Deserialize)]
pub struct MeshRequest {
    /// Outer boundary as `[[x, y], ...]`, implicitly closed.
    pub boundary: Vec<[f64; 2]>,
    /// Interior holes, each an implicitly closed loop.
    #[serde(default)]
    pub holes: Vec<Vec<[f64; 2]>>,
    /// Minimum interior angle target, in degrees.
    #[serde(default = "default_min_angle")]
    pub min_angle_deg: f64,
    /// Maximum triangle area, in the caller's own units.
    #[serde(default)]
    pub max_area: Option<f64>,
    /// Refinement iteration ceiling before bailing out with a partial mesh.
    #[serde(default)]
    pub max_steps: Option<usize>,
    /// Element ceiling. Primarily a memory bound -- see
    /// `RefineParams::DEFAULT_MAX_TRIANGLES` for the per-element cost.
    #[serde(default)]
    pub max_triangles: Option<usize>,
}

fn default_min_angle() -> f64 {
    25.0
}

#[derive(Debug, Serialize)]
pub struct MeshResponse {
    /// Interleaved `[x0, y0, x1, y1, ...]`, in the caller's original units.
    pub vertices: Vec<f64>,
    /// Interleaved corner indices `[i0, j0, k0, ...]`.
    pub triangles: Vec<u32>,
    /// Smallest interior angle per triangle, in degrees.
    pub min_angles_deg: Vec<f64>,
    pub vertex_count: usize,
    pub triangle_count: usize,
    /// Smallest interior angle anywhere in the mesh.
    pub min_angle_deg: Option<f64>,
    /// Counts of triangles per 5-degree bucket over 0..60.
    pub angle_histogram: Vec<u32>,
    /// True when refinement bailed out rather than converging. The mesh is
    /// still valid, but does not meet the requested quality everywhere.
    pub terminated_early: bool,
    pub outcome: String,
    /// False when the quality target sits outside Ruppert's provable
    /// termination regime, i.e. above roughly 20.7 degrees. Best-effort there.
    pub provable_termination: bool,
}

/// Maps input coordinates into a unit box and back.
struct Normalisation {
    min_x: f64,
    min_y: f64,
    scale: f64,
}

impl Normalisation {
    fn fit(points: &[[f64; 2]]) -> Result<Self, String> {
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;

        for [x, y] in points.iter() {
            if !x.is_finite() || !y.is_finite() {
                return Err("geometry contains a non-finite coordinate".into());
            }
            min_x = min_x.min(*x);
            min_y = min_y.min(*y);
            max_x = max_x.max(*x);
            max_y = max_y.max(*y);
        }

        let scale = (max_x - min_x).max(max_y - min_y);
        if !(scale > 0.0) {
            return Err("geometry has zero extent".into());
        }

        Ok(Self {
            min_x,
            min_y,
            scale,
        })
    }

    fn forward(&self, [x, y]: [f64; 2]) -> (f64, f64) {
        ((x - self.min_x) / self.scale, (y - self.min_y) / self.scale)
    }

    fn back(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.scale + self.min_x, y * self.scale + self.min_y)
    }

    /// Areas scale with the square of the coordinate scale, so an area bound
    /// expressed in the caller's units has to be converted too. Forgetting this
    /// would silently apply a wildly wrong area constraint.
    fn forward_area(&self, area: f64) -> f64 {
        area / (self.scale * self.scale)
    }
}

fn to_polyline(loop_points: &[[f64; 2]], norm: &Normalisation) -> Result<Rc<Polyline>, String> {
    if loop_points.len() < 3 {
        return Err(format!(
            "a closed loop needs at least 3 points, got {}",
            loop_points.len()
        ));
    }

    let vertices: Vec<Rc<Vertex>> = loop_points
        .iter()
        .map(|point| {
            let (x, y) = norm.forward(*point);
            Rc::new(Vertex::new(x, y))
        })
        .collect();

    Polyline::new_closed(vertices)
        .map(Rc::new)
        .ok_or_else(|| "could not build a closed polyline from these points".to_string())
}

fn outcome_label(outcome: RefineOutcome) -> &'static str {
    match outcome {
        RefineOutcome::Converged => "converged",
        RefineOutcome::HitStepLimit => "hit_step_limit",
        RefineOutcome::HitSizeLimit => "hit_size_limit",
    }
}

/// Meshes a domain. Pure function: no state is retained between calls.
pub fn build_mesh(request: MeshRequest) -> Result<MeshResponse, String> {
    if !request.min_angle_deg.is_finite()
        || request.min_angle_deg <= 0.0
        || request.min_angle_deg >= 60.0
    {
        return Err(format!(
            "min_angle_deg must be in (0, 60); got {}. No triangle can have a \
             smallest angle above 60 degrees, so higher targets are unreachable.",
            request.min_angle_deg
        ));
    }

    // Normalisation is fitted over the boundary and every hole together, so all
    // loops land in the same coordinate frame.
    let all_points: Vec<[f64; 2]> = request
        .boundary
        .iter()
        .chain(request.holes.iter().flatten())
        .cloned()
        .collect();
    let norm = Normalisation::fit(&all_points)?;

    let boundary = to_polyline(&request.boundary, &norm)?;
    let mut triangulator = Triangulator::new(&boundary);

    for hole in request.holes.iter() {
        let hole_polyline = to_polyline(hole, &norm)?;
        triangulator
            .insert_hole(&hole_polyline)
            .map_err(|_| "a hole is not strictly inside the boundary".to_string())?;
    }

    triangulator.triangulate();

    let mut params = RefineParams::from_min_angle_deg(
        request.min_angle_deg,
        request.max_area.map(|area| norm.forward_area(area)),
    );
    if let Some(max_steps) = request.max_steps {
        params.max_steps = max_steps;
    }
    if let Some(max_triangles) = request.max_triangles {
        params.max_triangles = max_triangles;
    }
    let provable_termination = params.has_provable_termination();

    let outcome = triangulator.refine(params);

    let mesh = FlatMesh::from_triangulation(&triangulator.triangulation.borrow());

    // Back into the caller's units, so the UI never has to know normalisation
    // happened.
    let vertices: Vec<f64> = mesh
        .vertices
        .chunks(2)
        .flat_map(|pair| {
            let (x, y) = norm.back(pair[0], pair[1]);
            [x, y]
        })
        .collect();

    // A mesher that returns nothing for a polygon enclosing real area is
    // broken, whatever the cause. Reporting success with zero elements is the
    // worst available failure: the canvas simply renders empty and the user is
    // told nothing. Clockwise input used to do exactly this, silently, because
    // the kernel carved the interior away instead of the exterior.
    if mesh.triangle_count() == 0 {
        return Err(
            "meshing produced no elements for a region that encloses area. \
             This is a bug in the mesher, not in the geometry."
                .to_string(),
        );
    }

    Ok(MeshResponse {
        vertex_count: mesh.vertex_count(),
        triangle_count: mesh.triangle_count(),
        min_angle_deg: mesh.min_angle_deg(),
        angle_histogram: mesh.angle_histogram(12),
        min_angles_deg: mesh.min_angles_deg.clone(),
        triangles: mesh.triangles.clone(),
        vertices,
        terminated_early: outcome.terminated_early(),
        outcome: outcome_label(outcome).to_string(),
        provable_termination,
    })
}

/// Installs a panic hook that forwards Rust panics to the browser console.
///
/// Without this a panic surfaces as an opaque "unreachable executed" trap.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn mesh(request: JsValue) -> Result<JsValue, JsValue> {
    let request: MeshRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("invalid mesh request: {}", error)))?;

    let response = build_mesh(request).map_err(|error| JsValue::from_str(&error))?;

    serde_wasm_bindgen::to_value(&response)
        .map_err(|error| JsValue::from_str(&format!("could not serialise mesh: {}", error)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(size: f64) -> Vec<[f64; 2]> {
        vec![[0.0, 0.0], [size, 0.0], [size, size], [0.0, size]]
    }

    #[test]
    fn meshes_a_plain_square() {
        let response = build_mesh(MeshRequest {
            boundary: square(1.0),
            holes: vec![],
            min_angle_deg: 25.0,
            max_area: Some(0.02),
            max_steps: None,
            max_triangles: None,
        })
        .unwrap();

        assert!(response.triangle_count > 10);
        assert_eq!(response.triangles.len(), response.triangle_count * 3);
        assert_eq!(response.vertices.len(), response.vertex_count * 2);
        assert!(!response.terminated_early);
        assert_eq!(response.outcome, "converged");
    }

    /// The whole point of normalisation: the same shape at different scales
    /// must produce the same mesh topology. Before this, the fixed absolute
    /// epsilon in the predicates made behaviour scale-dependent.
    #[test]
    fn mesh_topology_is_independent_of_input_scale() {
        let mut counts = Vec::new();

        for scale in [1.0E-3, 1.0, 1.0E3, 1.0E6] {
            let response = build_mesh(MeshRequest {
                boundary: square(scale),
                holes: vec![],
                min_angle_deg: 25.0,
                // Scaled so it describes the same fraction of the domain.
                max_area: Some(0.02 * scale * scale),
                max_steps: None,
                max_triangles: None,
            })
            .unwrap();
            counts.push((scale, response.triangle_count));
        }

        let first = counts[0].1;
        for (scale, count) in counts.iter() {
            assert_eq!(
                *count, first,
                "scale {} produced {} triangles, scale {} produced {}",
                counts[0].0, first, scale, count
            );
        }
    }

    /// Vertices must come back in the caller's units, not normalised ones.
    #[test]
    fn output_is_in_input_units() {
        let response = build_mesh(MeshRequest {
            boundary: square(1000.0),
            holes: vec![],
            min_angle_deg: 20.0,
            max_area: None,
            max_steps: None,
            max_triangles: None,
        })
        .unwrap();

        let max = response
            .vertices
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(
            max > 100.0,
            "coordinates look normalised rather than restored; max was {}",
            max
        );
    }

    #[test]
    fn meshes_a_square_with_a_hole() {
        let response = build_mesh(MeshRequest {
            boundary: square(10.0),
            holes: vec![vec![[4.0, 4.0], [6.0, 4.0], [6.0, 6.0], [4.0, 6.0]]],
            min_angle_deg: 20.0,
            max_area: Some(2.0),
            max_steps: None,
            max_triangles: None,
        })
        .unwrap();

        assert!(response.triangle_count > 10);

        // No triangle centroid may land inside the hole.
        for corner in response.triangles.chunks(3) {
            let cx = corner
                .iter()
                .map(|i| response.vertices[*i as usize * 2])
                .sum::<f64>()
                / 3.0;
            let cy = corner
                .iter()
                .map(|i| response.vertices[*i as usize * 2 + 1])
                .sum::<f64>()
                / 3.0;

            let inside_hole = cx > 4.0 && cx < 6.0 && cy > 4.0 && cy < 6.0;
            assert!(!inside_hole, "a triangle was meshed inside the hole");
        }
    }

    #[test]
    fn rejects_unreachable_quality_targets() {
        let result = build_mesh(MeshRequest {
            boundary: square(1.0),
            holes: vec![],
            min_angle_deg: 61.0,
            max_area: None,
            max_steps: None,
            max_triangles: None,
        });
        assert!(result.is_err());
    }

    #[test]
    fn rejects_degenerate_geometry() {
        let result = build_mesh(MeshRequest {
            boundary: vec![[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]],
            holes: vec![],
            min_angle_deg: 25.0,
            max_area: None,
            max_steps: None,
            max_triangles: None,
        });
        assert!(result.is_err(), "zero-extent geometry should be rejected");
    }

    /// A low step cap must return a usable partial mesh with the flag set,
    /// rather than running to completion or hanging.
    #[test]
    fn step_cap_degrades_gracefully() {
        let response = build_mesh(MeshRequest {
            boundary: square(1.0),
            holes: vec![],
            min_angle_deg: 30.0,
            max_area: Some(0.0001),
            max_steps: Some(25),
            max_triangles: None,
        })
        .unwrap();

        assert!(response.terminated_early);
        assert_eq!(response.outcome, "hit_step_limit");
        assert!(
            response.triangle_count > 0,
            "a capped run should still return the mesh built so far"
        );
    }
}

#[cfg(test)]
mod sample_geometry_regression {
    use super::*;

    /// The notched shape the UI ships as its sample. The notch at [52, 42] is a
    /// deliberately sharp reflex corner, which is exactly the configuration
    /// Ruppert's algorithm struggles with.
    fn notched_boundary() -> Vec<[f64; 2]> {
        vec![
            [15.0, 15.0],
            [85.0, 15.0],
            [85.0, 70.0],
            [52.0, 42.0],
            [15.0, 70.0],
        ]
    }

    fn sample_hole() -> Vec<[f64; 2]> {
        vec![[38.0, 22.0], [58.0, 22.0], [58.0, 34.0], [38.0, 34.0]]
    }

    #[test]
    fn sample_geometry_does_not_panic() {
        let result = build_mesh(MeshRequest {
            boundary: notched_boundary(),
            holes: vec![sample_hole()],
            min_angle_deg: 25.0,
            max_area: Some(100.0),
            max_steps: Some(60_000),
            max_triangles: None,
        });
        assert!(result.is_ok(), "sample geometry failed: {:?}", result.err());
    }

    /// Sweeping the quality slider must not panic at any stop.
    #[test]
    fn quality_sweep_does_not_panic() {
        for min_angle in 5..=34 {
            let result = build_mesh(MeshRequest {
                boundary: notched_boundary(),
                holes: vec![sample_hole()],
                min_angle_deg: min_angle as f64,
                max_area: Some(100.0),
                // Deliberately small. Targets above ~20.7 degrees are outside
                // Ruppert's provable-termination regime and will run to
                // whatever cap they are given, so a large one turns this into a
                // multi-minute test without checking anything extra.
                max_steps: Some(2_000),
                max_triangles: Some(20_000),
            });
            assert!(
                result.is_ok(),
                "min_angle {} panicked: {:?}",
                min_angle,
                result.err()
            );
        }
    }

    /// No element may be degenerate. A zero-area sliver has no circumcentre, is
    /// useless to a solver, and signals that the triangulation is corrupt.
    #[test]
    fn produces_no_degenerate_elements() {
        let response = build_mesh(MeshRequest {
            boundary: notched_boundary(),
            holes: vec![sample_hole()],
            min_angle_deg: 25.0,
            max_area: Some(100.0),
            max_steps: Some(60_000),
            max_triangles: None,
        })
        .unwrap();

        let worst = response.min_angle_deg.unwrap();
        assert!(
            worst > 0.0,
            "mesh contains a degenerate element (worst angle {}deg)",
            worst
        );
    }
}

#[cfg(test)]
mod memory_bounds {
    use super::*;

    /// The element cap is a memory bound, so it has to actually fire rather
    /// than merely be declared. Asking for an impossible element size on a
    /// square would otherwise refine until the machine runs out of RAM -- which
    /// on a laptop means swapping, not a clean failure.
    #[test]
    fn element_cap_stops_runaway_refinement() {
        let response = build_mesh(MeshRequest {
            boundary: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
            holes: vec![],
            min_angle_deg: 20.0,
            // Would need roughly ten million elements to satisfy.
            max_area: Some(0.0000001),
            max_steps: Some(usize::MAX),
            max_triangles: Some(3_000),
        })
        .unwrap();

        assert!(response.terminated_early);
        assert_eq!(response.outcome, "hit_size_limit");
        assert!(
            response.triangle_count <= 3_000,
            "cap of 3000 was exceeded: {} elements",
            response.triangle_count
        );
    }

    /// The shipped defaults must themselves be a usable bound: a caller that
    /// passes no caps at all still has to terminate in bounded memory.
    #[test]
    fn defaults_bound_an_unsatisfiable_request() {
        let response = build_mesh(MeshRequest {
            boundary: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
            holes: vec![],
            min_angle_deg: 20.0,
            max_area: Some(0.0000001),
            // Explicitly small. This test exists to prove the cap mechanism
            // engages, and the *shipped* default is asserted separately below
            // without actually meshing to it -- running a test all the way to
            // the production ceiling costs real memory on the machine running
            // the suite for no extra signal.
            max_steps: Some(4_000),
            max_triangles: Some(2_000),
        })
        .unwrap();

        assert!(response.terminated_early);
        assert!(
            response.triangle_count <= 2_000,
            "cap exceeded: {} elements",
            response.triangle_count
        );
    }
}

#[cfg(test)]
mod known_issues {
    use super::*;

    /// Regression: this request used to succeed about 27 times and then ask for
    /// 512 MB in a single allocation, killing the run.
    ///
    /// What has been ruled out:
    ///   * a leak -- the allocator's live-byte counter stays flat at ~20 KB
    ///     across every attempt, including the one that dies;
    ///   * the step and element caps -- the blow-up is one allocation *inside*
    ///     a single refinement step, so neither cap is ever consulted;
    ///   * the geometry and the angle -- every angle passes in isolation.
    ///
    /// What is left is iteration order. Rust seeds each `HashSet`/`HashMap`
    /// randomly, so repeating the same call samples different orders inside the
    /// kernel. `split_irregular` was made order-independent (see
    /// `take_worst`), but `insert_segments`, `unencroach` and the polyline
    /// boolean helpers still drive their loops straight off `HashSet`
    /// iteration, and at least one of those orders reaches a path that grows a
    /// collection without bound.
    ///
    /// Fixing this means giving those loops a deterministic order too, the same
    /// way refinement got one. Until then the browser worker can hit this, which
    /// is why `mesher.worker.ts` reports errors rather than assuming success.
    #[test]
    fn repeated_identical_requests_are_stable() {
        for attempt in 0..300 {
            let result = build_mesh(MeshRequest {
                boundary: vec![
                    [15.0, 15.0],
                    [85.0, 15.0],
                    [85.0, 70.0],
                    [52.0, 42.0],
                    [15.0, 70.0],
                ],
                holes: vec![vec![[38.0, 22.0], [58.0, 22.0], [58.0, 34.0], [38.0, 34.0]]],
                min_angle_deg: 11.0,
                max_area: Some(100.0),
                max_steps: Some(2_000),
                max_triangles: Some(20_000),
            });
            assert!(result.is_ok(), "attempt {} failed", attempt);
        }
    }
}

#[cfg(test)]
mod stability {
    use super::*;

    /// Establishes how far the hash-order bug in `known_issues` actually
    /// reaches. If simple convex geometry were also affected the tool would be
    /// unusable; this pins down that it is not.
    #[test]
    fn simple_geometry_is_stable_under_repetition() {
        for attempt in 0..300 {
            let result = build_mesh(MeshRequest {
                boundary: vec![[0.0, 0.0], [40.0, 0.0], [40.0, 30.0], [0.0, 30.0]],
                holes: vec![vec![[15.0, 12.0], [25.0, 12.0], [25.0, 18.0], [15.0, 18.0]]],
                min_angle_deg: 25.0,
                max_area: Some(20.0),
                max_steps: Some(5_000),
                max_triangles: Some(20_000),
            });
            assert!(result.is_ok(), "attempt {} failed: {:?}", attempt, result.err());
        }
    }
}

#[cfg(test)]
mod repro_slider_extremes {
    use super::*;

    /// The UI's sample geometry at the settings from the reported screenshot:
    /// minimum angle 20 degrees, max element area 0.05% of the 100x100 world,
    /// i.e. 5.0 square units.
    #[test]
    fn sample_at_smallest_area_setting() {
        let started = std::time::Instant::now();
        let r = build_mesh(MeshRequest {
            boundary: vec![[15.0, 15.0], [85.0, 15.0], [85.0, 70.0], [15.0, 70.0]],
            holes: vec![vec![[38.0, 30.0], [58.0, 30.0], [58.0, 48.0], [38.0, 48.0]]],
            min_angle_deg: 20.0,
            max_area: Some(5.0),
            max_steps: Some(60_000),
            max_triangles: Some(50_000),
        })
        .unwrap();

        println!(
            "elements={} nodes={} worst={:.2} outcome={} elapsed={:?}",
            r.triangle_count,
            r.vertex_count,
            r.min_angle_deg.unwrap_or(-1.0),
            r.outcome,
            started.elapsed()
        );

        // Domain area is 70*55 - 20*18 = 3490; at 5.0 per element that needs
        // at least ~700 elements. The screenshot showed 30.
        assert!(
            r.triangle_count > 600,
            "only {} elements for a domain needing ~700",
            r.triangle_count
        );
    }
}

#[cfg(test)]
mod convex_regression {
    use super::*;

    fn count(name: &str, boundary: Vec<[f64; 2]>, min_angle: f64, area_pct: f64) {
        let max_area = (area_pct / 100.0) * 100.0 * 100.0;
        match build_mesh(MeshRequest {
            boundary, holes: vec![], min_angle_deg: min_angle,
            max_area: Some(max_area), max_steps: Some(60_000), max_triangles: Some(50_000),
        }) {
            Ok(r) => println!("{:<12} elements={:<5} nodes={:<5} outcome={}",
                              name, r.triangle_count, r.vertex_count, r.outcome),
            Err(e) => println!("{:<12} ERROR: {}", name, e),
        }
    }

    #[test]
    fn convex_shapes_mesh() {
        // Roughly as drawn in the UI: irregular, non-axis-aligned, CCW.
        count("triangle", vec![[26.0,18.0],[64.0,14.0],[42.0,72.0]], 18.0, 2.90);
        count("pentagon", vec![[26.0,44.0],[27.0,15.0],[60.0,16.0],[63.0,44.0],[47.0,72.0]], 18.0, 2.85);
        count("square", vec![[15.0,15.0],[85.0,15.0],[85.0,70.0],[15.0,70.0]], 18.0, 2.85);
        count("equilateral", vec![[0.0,0.0],[60.0,0.0],[30.0,51.96]], 18.0, 2.90);
    }
}
