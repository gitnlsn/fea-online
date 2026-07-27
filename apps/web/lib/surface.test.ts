import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoZScale,
  buildElementOutlines,
  buildPlanOutline,
  buildSurface,
  latticeIndex,
} from "./surface.ts";
import { WORLD_SIZE } from "./viewport.ts";
import type { SolveResponse } from "./solve.ts";

/**
 * `sub_triangles(2)` exactly as `crates/fea-wasm/src/sample.rs` emits it.
 *
 * Transcribed from the Rust rather than derived here: it is the fixed point the
 * TypeScript `latticeIndex` is checked against, so deriving it from the same
 * assumption would check nothing.
 */
const SUB_TRIANGLES_N2 = [0, 1, 3, 1, 4, 3, 1, 2, 4, 3, 4, 5];

/**
 * Two elements on an order-2 lattice.
 *
 * The two share the edge from (1,0) to (0,1) and deliberately disagree across
 * it -- element 0 reads 0 there, element 1 reads 100 -- which is the case the
 * whole non-indexed layout exists to preserve.
 */
function twoElements(): SolveResponse {
  const first: [number, number][] = [
    [0, 0],
    [0.5, 0],
    [1, 0],
    [0, 0.5],
    [0.5, 0.5],
    [0, 1],
  ];
  // The second element is the first mirrored about x + y = 1.
  const second = first.map(([x, y]) => [1 - x, 1 - y] as [number, number]);

  return {
    positions: [...first, ...second].flat(),
    values: [0, 0, 0, 0, 0, 0, 100, 100, 100, 100, 100, 100],
    sub_triangles: SUB_TRIANGLES_N2,
    sample_stride: 6,
    subdivisions: 2,
    element_count: 2,
    mode_count: 3,
    degree: 1,
    min_value: 0,
    max_value: 100,
    iterations: 1,
    residual_norm: 0,
    initial_norm: 1,
    converged: true,
    singular: false,
    unclassified_faces: 0,
    worst_match_distance: 0,
  };
}

describe("latticeIndex", () => {
  it("reproduces the ordering the sampler emitted", () => {
    // Walking the lattice in the sampler's own order must number the points
    // 0, 1, 2, ... -- if it does not, every index in `sub_triangles` means
    // something different here than it did in Rust.
    const n = 2;
    let expected = 0;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n - j; i++) {
        assert.equal(latticeIndex(i, j, n), expected++);
      }
    }
  });

  it("agrees with the corners of the emitted sub-triangles", () => {
    // The first sub-triangle of the first cell is (i,j), (i+1,j), (i,j+1).
    assert.deepEqual(
      [latticeIndex(0, 0, 2), latticeIndex(1, 0, 2), latticeIndex(0, 1, 2)],
      SUB_TRIANGLES_N2.slice(0, 3),
    );
    // The last one is the upward triangle of the top cell.
    assert.deepEqual(
      [latticeIndex(0, 1, 2), latticeIndex(1, 1, 2), latticeIndex(0, 2, 2)],
      SUB_TRIANGLES_N2.slice(9, 12),
    );
  });

  it("numbers every point of a larger lattice exactly once", () => {
    for (const n of [1, 3, 4]) {
      const seen = new Set<number>();
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n - j; i++) seen.add(latticeIndex(i, j, n));
      }
      assert.equal(seen.size, ((n + 1) * (n + 2)) / 2);
      assert.equal(Math.max(...seen), seen.size - 1);
    }
  });
});

describe("buildSurface", () => {
  const solution = twoElements();
  const surface = buildSurface(solution);

  it("emits three unshared vertices per sub-triangle", () => {
    // 2 elements x 4 sub-triangles x 3 corners x 3 floats.
    assert.equal(surface.length, 2 * 4 * 3 * 3);
  });

  it("carries the raw field value as z, unscaled", () => {
    // The first element reads 0 everywhere, the second 100 everywhere.
    for (let vertex = 0; vertex < 12; vertex++) assert.equal(surface[vertex * 3 + 2], 0);
    for (let vertex = 12; vertex < 24; vertex++) assert.equal(surface[vertex * 3 + 2], 100);
  });

  it("keeps the jump across a shared edge", () => {
    // (0.5, 0.5) is on the shared edge and appears in both elements. Both copies
    // must survive, with their own values -- welding them would lose the jump.
    const at = [];
    for (let vertex = 0; vertex < surface.length / 3; vertex++) {
      const [x, y, z] = surface.slice(vertex * 3, vertex * 3 + 3);
      if (Math.abs(x - 0.5) < 1e-9 && Math.abs(y - 0.5) < 1e-9) at.push(z);
    }

    assert.ok(at.includes(0), "the low side of the jump is missing");
    assert.ok(at.includes(100), "the high side of the jump is missing");
  });
});

describe("buildElementOutlines", () => {
  const solution = twoElements();
  const outlines = buildElementOutlines(solution);

  it("emits the three sides of each element, not every sub-triangle edge", () => {
    // 3n segments per element, two endpoints each, three floats each. The
    // sub-triangle edges would be far more.
    assert.equal(outlines.length, 2 * (3 * 2) * 2 * 3);
  });

  it("traces a closed loop around the element", () => {
    // Consecutive segments must join: the end of one is the start of the next,
    // all the way around and back to where it started.
    const point = (index: number) => outlines.slice(index * 3, index * 3 + 3).join();
    for (let segment = 0; segment < 5; segment++) {
      assert.equal(point(segment * 2 + 1), point(segment * 2 + 2), `break after ${segment}`);
    }
    assert.equal(point(11), point(0), "the outline does not close");
  });

  it("stays on the boundary of the reference triangle", () => {
    // Nothing on the outline may be an interior lattice point. For the first
    // element that means the midpoint (0.5, 0.5) is allowed -- it is on the
    // hypotenuse -- but a point with both coordinates strictly inside is not.
    for (let vertex = 0; vertex < 12; vertex++) {
      const [x, y] = outlines.slice(vertex * 3, vertex * 3 + 3);
      const interior = x > 1e-9 && y > 1e-9 && x + y < 1 - 1e-9;
      assert.ok(!interior, `interior point (${x}, ${y}) on the outline`);
    }
  });
});

describe("buildPlanOutline", () => {
  it("closes each loop", () => {
    const outline = buildPlanOutline(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      [],
    );

    assert.equal(outline.length, 3 * 2 * 3);
    // Last segment ends where the first begins.
    assert.deepEqual([...outline.slice(15, 18)], [...outline.slice(0, 3)]);
  });

  it("lies flat on the ground plane", () => {
    const outline = buildPlanOutline(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      [
        [
          [2, 2],
          [4, 2],
          [4, 4],
        ],
      ],
    );

    for (let vertex = 0; vertex < outline.length / 3; vertex++) {
      assert.equal(outline[vertex * 3 + 2], 0);
    }
  });
});

describe("autoZScale", () => {
  it("opens fields many orders of magnitude apart at the same height", () => {
    const relief = (min: number, max: number) => (max - min) * autoZScale(min, max);
    assert.ok(Math.abs(relief(0, 100) - relief(0, 1e-6)) < 1e-9);
    assert.ok(relief(0, 100) > 0 && relief(0, 100) < WORLD_SIZE);
  });

  it("survives a flat field", () => {
    assert.ok(Number.isFinite(autoZScale(5, 5)));
    assert.ok(autoZScale(5, 5) > 0);
  });
});
