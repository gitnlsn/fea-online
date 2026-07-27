//! Matching mesh boundary faces back to the segments the user drew.
//!
//! Neither `FlatMesh` nor the wasm `MeshResponse` carries boundary markers, so
//! the only signal available is geometry -- a point noted in the solver's own
//! boundary module, which says the classifier is the single place that changes
//! if the mesher ever grows real markers.
//!
//! The match is exact rather than approximate, and that is worth stating
//! because "nearest segment" sounds like a heuristic. Refinement only ever
//! *splits* an input segment, at the segment's own midpoint, so every boundary
//! face lies on the segment it came from to within a couple of roundings. The
//! only other perturbation is the mesher's normalisation round trip, which
//! costs about `1e-16` of the domain extent. A face's true segment therefore
//! sits some ten orders of magnitude closer than any other, and the tolerance
//! below has nothing to resolve.
//!
//! ## Why this runs in Rust and not in the web app
//!
//! The web app authored the segments, so it looks like the natural place to do
//! the matching. It is not, for two reasons that are properties of the solver
//! rather than preferences:
//!
//! 1. Boundary *faces* exist only inside `DgMesh`. Classifying in JavaScript
//!    would mean reimplementing edge-to-element adjacency there and keeping two
//!    implementations of a load-bearing invariant in step.
//! 2. `DgMesh::from_arrays` renumbers element corners to normalise winding. Face
//!    indices and normal directions computed in JavaScript would not line up
//!    with the ones the operator uses unless JavaScript reproduced that too.
//!
//! So the web app supplies only what it actually knows -- the segments it drew
//! -- and everything downstream of the mesh stays on this side of the boundary.

use fea_dg::mesh::boundary::BoundaryMap;
use fea_dg::mesh::dg_mesh::DgMesh;

/// How far a face midpoint may sit from its segment, relative to the mesh
/// diameter, before the match is refused.
///
/// Ten orders of magnitude above the round-off the match actually incurs, and
/// far below any real separation between distinct segments: two input segments
/// meeting at one degree still place a face on one of them roughly `1e-3` from
/// the other. There is a wide empty band here, and the constant sits in it.
const MATCH_TOLERANCE: f64 = 1e-6;

/// A tagged boundary, and how much the tagging had to guess.
pub struct Classification {
    pub map: BoundaryMap,
    /// Faces no segment claimed, which fell back to the fallback tag.
    pub unclassified: usize,
    /// Largest accepted midpoint-to-segment distance, relative to the mesh
    /// diameter. Expected to be around `1e-15`; anything larger means the
    /// segments do not describe the domain that was meshed.
    pub worst_relative_distance: f64,
}

/// Distance from `p` to the segment `a`-`b`, with the projection clamped to the
/// segment rather than extended along its line.
///
/// Clamping is what makes this usable as a matcher. An unclamped perpendicular
/// distance reports zero for any point on a segment's *supporting line*, so a
/// short segment would claim faces from a collinear one metres away -- and
/// collinear input edges are ordinary, not pathological: any loop with two
/// aligned sides has them.
pub fn point_segment_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let length_squared = dx * dx + dy * dy;

    // A degenerate segment is a point; the distance to it is still well defined,
    // and refusing to divide by zero here is cheaper than validating upstream.
    let t = if length_squared > 0.0 {
        ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length_squared
    } else {
        0.0
    }
    .clamp(0.0, 1.0);

    let cx = a[0] + t * dx;
    let cy = a[1] + t * dy;
    (p[0] - cx).hypot(p[1] - cy)
}

/// Assigns each boundary face the tag of the input segment it lies on.
///
/// `segments` is interleaved `[ax, ay, bx, by, ...]` and `tags[i]` is the tag of
/// segment `i`. Faces matching nothing within tolerance take `fallback`, which
/// callers must ensure is a tag with a condition behind it: the solver asserts
/// that every tag is in range, and an assertion here would abort the whole wasm
/// instance rather than fail one request.
pub fn classify_boundary(
    mesh: &DgMesh,
    segments: &[f64],
    tags: &[u16],
    fallback: u16,
) -> Classification {
    let diameter = mesh.max_diameter();
    let cutoff = MATCH_TOLERANCE * diameter;

    let mut unclassified = 0usize;
    let mut worst = 0.0f64;

    let map = BoundaryMap::classify(mesh, |midpoint, _normal| {
        let mut best_index: Option<usize> = None;
        let mut best_distance = f64::INFINITY;

        for (index, chunk) in segments.chunks_exact(4).enumerate() {
            let distance =
                point_segment_distance(midpoint, [chunk[0], chunk[1]], [chunk[2], chunk[3]]);
            // Strictly less than, so a tie leaves the earlier segment in place.
            // Ties are vanishingly unlikely and entirely possible -- a duplicated
            // edge in a loaded file produces one -- and resolving them by
            // iteration order would make the same input tag differently on
            // different runs.
            if distance < best_distance {
                best_distance = distance;
                best_index = Some(index);
            }
        }

        match best_index {
            Some(index) if best_distance <= cutoff => {
                if diameter > 0.0 {
                    worst = worst.max(best_distance / diameter);
                }
                tags[index]
            }
            _ => {
                unclassified += 1;
                fallback
            }
        }
    });

    Classification {
        map,
        unclassified,
        worst_relative_distance: worst,
    }
}

#[cfg(test)]
mod classification {
    use super::*;
    use crate::{build_mesh, MeshRequest};
    use fea_dg::mesh::dg_mesh::DgMesh;

    /// Meshes a closed loop and returns the solver's view of it, along with the
    /// loop's edges flattened into the segment table `classify_boundary` takes.
    fn mesh_loop(loop_points: &[[f64; 2]], max_area: f64) -> (DgMesh, Vec<f64>) {
        let response = build_mesh(MeshRequest {
            boundary: loop_points.to_vec(),
            holes: vec![],
            min_angle_deg: 25.0,
            max_area: Some(max_area),
            max_steps: None,
            max_triangles: None,
        })
        .unwrap();

        let mesh = DgMesh::from_arrays(&response.vertices, &response.triangles).unwrap();
        (mesh, segments_of(loop_points))
    }

    fn segments_of(loop_points: &[[f64; 2]]) -> Vec<f64> {
        let n = loop_points.len();
        (0..n)
            .flat_map(|i| {
                let a = loop_points[i];
                let b = loop_points[(i + 1) % n];
                [a[0], a[1], b[0], b[1]]
            })
            .collect()
    }

    const UNIT_SQUARE: [[f64; 2]; 4] = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];

    /// The base case the whole feature rests on: four drawn edges, four tags,
    /// every boundary face landing on the right one.
    #[test]
    fn the_four_sides_of_a_square_get_their_own_tags() {
        let (mesh, segments) = mesh_loop(&UNIT_SQUARE, 0.02);
        let result = classify_boundary(&mesh, &segments, &[0, 1, 2, 3], 0);

        assert_eq!(result.unclassified, 0);
        assert_eq!(result.map.len(), mesh.boundary_faces().len());

        // Every side must claim at least one face, and each face's tag must
        // agree with where the face actually is. Checking position rather than
        // only counts is what distinguishes "four groups" from "four *correct*
        // groups" -- a rotated tagging would pass a count-only assertion.
        let mut per_side = [0usize; 4];
        for (index, &face) in mesh.boundary_faces().iter().enumerate() {
            let [x, y] = mesh.face_midpoint(face);
            let expected = if y < 1e-9 {
                0 // bottom: [0,0] -> [1,0]
            } else if x > 1.0 - 1e-9 {
                1 // right
            } else if y > 1.0 - 1e-9 {
                2 // top
            } else {
                3 // left
            };
            assert_eq!(
                result.map.tag(index),
                expected,
                "face at ({x}, {y}) was tagged {}",
                result.map.tag(index)
            );
            per_side[expected as usize] += 1;
        }
        assert!(per_side.iter().all(|&count| count > 0));
    }

    /// The property everything else depends on. Refinement splits a drawn edge
    /// into many faces; each of those must still answer to the edge it came
    /// from, or a condition set on one side would apply to a fraction of it.
    #[test]
    fn a_split_segment_keeps_its_tag() {
        // Small enough to force many faces per side.
        let (mesh, segments) = mesh_loop(&UNIT_SQUARE, 0.002);
        let result = classify_boundary(&mesh, &segments, &[0, 1, 2, 3], 0);

        let bottom = mesh
            .boundary_faces()
            .iter()
            .enumerate()
            .filter(|(_, &face)| mesh.face_midpoint(face)[1] < 1e-9)
            .count();

        assert!(bottom > 4, "expected a split side, got {bottom} faces");
        assert_eq!(result.unclassified, 0);
        for (index, &face) in mesh.boundary_faces().iter().enumerate() {
            if mesh.face_midpoint(face)[1] < 1e-9 {
                assert_eq!(result.map.tag(index), 0);
            }
        }
    }

    /// A hole's boundary is a boundary too. If hole faces leaked into the outer
    /// loop's tag, a heated inclusion would silently become a heated wall.
    #[test]
    fn holes_are_tagged_separately_from_the_outer_boundary() {
        let hole = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]];
        let response = build_mesh(MeshRequest {
            boundary: UNIT_SQUARE.to_vec(),
            holes: vec![hole.to_vec()],
            min_angle_deg: 25.0,
            max_area: Some(0.01),
            max_steps: None,
            max_triangles: None,
        })
        .unwrap();
        let mesh = DgMesh::from_arrays(&response.vertices, &response.triangles).unwrap();

        let mut segments = segments_of(&UNIT_SQUARE);
        segments.extend(segments_of(&hole));
        let tags = [0, 0, 0, 0, 1, 1, 1, 1];

        let result = classify_boundary(&mesh, &segments, &tags, 0);
        assert_eq!(result.unclassified, 0);

        let mut outer = 0;
        let mut inner = 0;
        for (index, &face) in mesh.boundary_faces().iter().enumerate() {
            let [x, y] = mesh.face_midpoint(face);
            let inside_hole = (0.4..=0.6).contains(&x) && (0.4..=0.6).contains(&y);
            match result.map.tag(index) {
                0 => {
                    assert!(!inside_hole, "outer tag on a hole face at ({x}, {y})");
                    outer += 1;
                }
                1 => {
                    assert!(inside_hole, "hole tag on an outer face at ({x}, {y})");
                    inner += 1;
                }
                other => panic!("unexpected tag {other}"),
            }
        }
        assert!(outer > 0 && inner > 0);
    }

    /// The no-panic guarantee. `LdgOperator::new` asserts that every tag has a
    /// condition behind it, and an assertion inside wasm aborts the instance and
    /// takes the worker with it -- so an unmatched face must degrade to a
    /// fallback tag rather than to no tag at all.
    #[test]
    fn a_face_matching_nothing_falls_back_without_panicking() {
        let (mesh, _) = mesh_loop(&UNIT_SQUARE, 0.02);

        // Segments describing a square nowhere near the meshed one.
        let elsewhere = segments_of(&[[90.0, 90.0], [91.0, 90.0], [91.0, 91.0], [90.0, 91.0]]);
        let result = classify_boundary(&mesh, &elsewhere, &[1, 1, 1, 1], 0);

        assert_eq!(result.unclassified, mesh.boundary_faces().len());
        assert!(result.map.tags().iter().all(|&tag| tag == 0));
        // Nothing was accepted, so nothing contributed to the worst distance.
        assert_eq!(result.worst_relative_distance, 0.0);
    }

    /// An empty segment table is the degenerate case of the above, and is
    /// reachable from a caller that forgot to send geometry.
    #[test]
    fn an_empty_segment_table_falls_back_rather_than_dividing_by_zero() {
        let (mesh, _) = mesh_loop(&UNIT_SQUARE, 0.02);
        let result = classify_boundary(&mesh, &[], &[], 0);

        assert_eq!(result.unclassified, mesh.boundary_faces().len());
        assert!(result.map.tags().iter().all(|&tag| tag == 0));
    }

    /// Two segments describing the same edge under different tags. Which one
    /// wins does not matter; that the same input always picks the same one does,
    /// because the alternative is a field that changes between identical runs.
    #[test]
    fn ties_break_deterministically() {
        let (mesh, segments) = mesh_loop(&UNIT_SQUARE, 0.02);

        // The bottom edge again, at the end of the table under tag 9.
        let mut duplicated = segments.clone();
        duplicated.extend_from_slice(&[0.0, 0.0, 1.0, 0.0]);
        let tags = [0, 1, 2, 3, 9];

        for _ in 0..8 {
            let result = classify_boundary(&mesh, &duplicated, &tags, 0);
            for (index, &face) in mesh.boundary_faces().iter().enumerate() {
                if mesh.face_midpoint(face)[1] < 1e-9 {
                    assert_eq!(
                        result.map.tag(index),
                        0,
                        "the duplicate claimed a face the earlier segment should hold"
                    );
                }
            }
        }
    }

    /// Clamping, stated as a property. The point sits far along the supporting
    /// line of a short segment: the unclamped perpendicular distance is zero,
    /// the honest one is not.
    #[test]
    fn distance_is_measured_to_the_segment_not_to_its_line() {
        let distance = point_segment_distance([10.0, 0.0], [0.0, 0.0], [1.0, 0.0]);
        assert!((distance - 9.0).abs() < 1e-12, "got {distance}");

        // And a point beside the segment measures the perpendicular as usual.
        let beside = point_segment_distance([0.5, 2.0], [0.0, 0.0], [1.0, 0.0]);
        assert!((beside - 2.0).abs() < 1e-12, "got {beside}");
    }

    /// A drawn loop is closed, so the matched distances should be round-off, not
    /// merely "small". This is the number that would grow first if the mesher
    /// started moving input vertices instead of only splitting between them.
    #[test]
    fn matched_faces_sit_on_their_segments_to_round_off() {
        let (mesh, segments) = mesh_loop(&UNIT_SQUARE, 0.01);
        let result = classify_boundary(&mesh, &segments, &[0, 1, 2, 3], 0);

        assert!(
            result.worst_relative_distance < 1e-12,
            "worst match was {:e} of the diameter",
            result.worst_relative_distance
        );
    }
}
