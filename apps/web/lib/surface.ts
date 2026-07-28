/**
 * Turns a solved field into the buffers the 3D view draws.
 *
 * Every buffer here is a flat `Float32Array` of `(x, y, z)` triples, and in
 * every one of them **z is the raw field value, not a height**. Vertical
 * exaggeration is a shader uniform, so changing it costs one `uniform1f` rather
 * than rebuilding and re-uploading tens of thousands of vertices. Buffers that
 * live on the ground plane just carry z = 0.
 */

import type { MeshResponse, Loop } from "./mesh.ts";
import type { DrawableField } from "./solve.ts";
import { MAJOR_STEP, WORLD_SIZE } from "./viewport.ts";

/**
 * Position of lattice point `(i, j)` in an element's flat sample ordering.
 *
 * A mirror of `lattice_index` in `crates/fea-wasm/src/sample.rs`. The wire
 * format sends `sub_triangles` but not the lattice's shape, and the element
 * *outline* -- as opposed to every sub-triangle edge -- can only be picked out
 * by knowing which points sit on the reference triangle's three sides. Pinned by
 * a test against a `sub_triangles` output rather than trusted, because the two
 * copies cannot be checked by the compiler.
 *
 * Rows run along `i`, and row `j` holds `n + 1 - j` points, so each row starts
 * where the triangular number of the rows above it ends.
 */
export function latticeIndex(i: number, j: number, n: number): number {
  return j * (n + 1) - (j * Math.max(0, j - 1)) / 2 + i;
}

/**
 * The solution as a non-indexed triangle soup: three vertices per sub-triangle,
 * none of them shared.
 *
 * Non-indexed on purpose, and not as an optimisation to be undone later. A
 * discontinuous Galerkin field has no single value where elements meet -- that
 * is the method, not a defect -- so the sample points along a shared edge arrive
 * duplicated, one copy per element, carrying different values. Welding them, or
 * averaging at shared nodes, would smooth away exactly the jumps the surface
 * exists to show. See `crates/fea-wasm/src/sample.rs` for the same argument at
 * the source.
 */
export function buildSurface(solution: DrawableField): Float32Array {
  const { positions, values, sub_triangles, sample_stride, element_count } = solution;
  const out = new Float32Array(element_count * sub_triangles.length * 3);

  let write = 0;
  for (let element = 0; element < element_count; element++) {
    const base = element * sample_stride;

    // `sub_triangles` is element-local and shared by every element, so the only
    // per-element work is the offset.
    for (let corner = 0; corner < sub_triangles.length; corner++) {
      const point = base + sub_triangles[corner];
      out[write++] = positions[point * 2];
      out[write++] = positions[point * 2 + 1];
      out[write++] = values[point];
    }
  }

  return out;
}

/**
 * The element borders, lifted onto the surface, as a line list.
 *
 * Element borders only -- not every sub-triangle edge. At `subdivisions = 4` the
 * lattice edges outnumber the element ones sixteen to one and turn the surface
 * into a mesh of noise; the element outline is the thing that corresponds to
 * "the mesh" as the 2D view uses the word, and it is where the DG jumps live.
 */
export function buildElementOutlines(solution: DrawableField): Float32Array {
  const { positions, values, sample_stride, element_count, subdivisions } = solution;
  const n = Math.max(1, subdivisions);

  // The three sides of the reference triangle, each as a walk of lattice
  // coordinates: the j = 0 row, the hypotenuse i + j = n, and the i = 0 column.
  const sides: number[][] = [[], [], []];
  for (let step = 0; step <= n; step++) {
    sides[0].push(latticeIndex(step, 0, n));
    sides[1].push(latticeIndex(n - step, step, n));
    sides[2].push(latticeIndex(0, n - step, n));
  }

  const segmentsPerElement = 3 * n;
  const out = new Float32Array(element_count * segmentsPerElement * 2 * 3);

  let write = 0;
  for (let element = 0; element < element_count; element++) {
    const base = element * sample_stride;

    for (const side of sides) {
      for (let step = 0; step + 1 < side.length; step++) {
        for (const local of [side[step], side[step + 1]]) {
          const point = base + local;
          out[write++] = positions[point * 2];
          out[write++] = positions[point * 2 + 1];
          out[write++] = values[point];
        }
      }
    }
  }

  return out;
}

/**
 * The mesh wireframe, flat on the ground plane, as a line list.
 *
 * Drawn from the mesh rather than from the solution because this is the *plan*:
 * the drawing you made, sitting under the answer. It is indexed geometry with
 * shared vertices, which is fine here -- there is no field on it to be
 * discontinuous.
 *
 * Every interior edge is emitted twice, once per adjoining triangle. Deduping
 * would need an edge set over a few thousand triangles on every solve to save
 * a buffer that is already small and drawn without blending, where a line over
 * itself is the same line.
 */
export function buildPlanWireframe(mesh: MeshResponse): Float32Array {
  const { vertices, triangles } = mesh;
  const out = new Float32Array(triangles.length * 2 * 3);

  let write = 0;
  for (let corner = 0; corner < triangles.length; corner += 3) {
    for (let edge = 0; edge < 3; edge++) {
      for (const local of [triangles[corner + edge], triangles[corner + ((edge + 1) % 3)]]) {
        out[write++] = vertices[local * 2];
        out[write++] = vertices[local * 2 + 1];
        out[write++] = 0;
      }
    }
  }

  return out;
}

/** The drawn outlines, flat on the ground plane, as a line list. */
export function buildPlanOutline(boundary: Loop | null, holes: Loop[]): Float32Array {
  const loops = [...(boundary ? [boundary] : []), ...holes];
  const segments = loops.reduce((total, loop) => total + loop.length, 0);
  const out = new Float32Array(segments * 2 * 3);

  let write = 0;
  for (const loop of loops) {
    for (let edge = 0; edge < loop.length; edge++) {
      // The closing edge is implicit in a `Loop`, so the last one wraps.
      for (const point of [loop[edge], loop[(edge + 1) % loop.length]]) {
        out[write++] = point[0];
        out[write++] = point[1];
        out[write++] = 0;
      }
    }
  }

  return out;
}

/** The world box's grid, flat on the ground plane, as a line list. */
export function buildPlanGrid(): Float32Array {
  const lines = (WORLD_SIZE / MAJOR_STEP + 1) * 2;
  const out = new Float32Array(lines * 2 * 3);

  let write = 0;
  for (let at = 0; at <= WORLD_SIZE; at += MAJOR_STEP) {
    out.set([at, 0, 0, at, WORLD_SIZE, 0], write);
    write += 6;
    out.set([0, at, 0, WORLD_SIZE, at, 0], write);
    write += 6;
  }

  return out;
}

/**
 * Fraction of the world box the field's range should span by default.
 *
 * The surface has to be tall enough to read as relief and short enough to stay
 * inside the frame next to a 100-unit-wide plan. A third of the width is the
 * ratio a contour plot is usually drawn at.
 */
const DEFAULT_RELIEF = 1 / 3;

/**
 * Vertical exaggeration that opens a field at a readable height.
 *
 * The field's units are whatever the physics made them: a plate held between 0
 * and 100 and the same plate at conductivity 1000 differ by six orders of
 * magnitude and both are ordinary requests. Fixing the *drawn* height rather
 * than the scale factor is what lets either open without touching a slider.
 *
 * The exaggeration is therefore not physical and the axis is not labelled. The
 * legend states the real numbers; the surface states the shape.
 */
export function autoZScale(min: number, max: number): number {
  const span = max - min;
  // A field that came out flat has no relief to scale. Any factor draws the same
  // plane, so pick the one that leaves the slider somewhere sensible.
  if (!(span > 0)) return 1;

  return (WORLD_SIZE * DEFAULT_RELIEF) / span;
}
