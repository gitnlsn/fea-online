import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeTransform,
  labelStep,
  pickEdge,
  pointSegmentDistance,
  snapPoint,
  toScreen,
  toWorld,
  WORLD_SIZE,
} from "./viewport.ts";
import type { Point } from "./mesh.ts";

describe("computeTransform", () => {
  const t = computeTransform(800, 600);

  it("fits the world box inside the gutters", () => {
    const [, topY] = toScreen([0, WORLD_SIZE], t);
    const [rightX] = toScreen([WORLD_SIZE, 0], t);
    const [originX, originY] = toScreen([0, 0], t);

    assert.ok(originX >= 28, `left gutter kept, got ${originX}`);
    assert.ok(originY <= 600 - 28, `bottom gutter kept, got ${originY}`);
    assert.ok(topY >= 0 && rightX <= 800);
  });

  it("puts world y=0 below world y=100 on screen", () => {
    const [, low] = toScreen([0, 0], t);
    const [, high] = toScreen([0, WORLD_SIZE], t);
    assert.ok(low > high, "y must increase upward");
  });

  it("round-trips through screen space", () => {
    for (const point of [[0, 0], [12.5, 87.25], [100, 100]] as Point[]) {
      const [x, y] = toScreen(point, t);
      const back = toWorld(x, y, t);
      assert.ok(Math.abs(back[0] - point[0]) < 1e-9);
      assert.ok(Math.abs(back[1] - point[1]) < 1e-9);
    }
  });
});

describe("snapPoint", () => {
  // A comfortable scale: 5 CSS pixels per world unit, so the 8px ortho band is
  // 1.6 world units wide.
  const scale = 5;

  it("passes the raw point through when disabled", () => {
    const raw: Point = [37.42, 22.81];
    const result = snapPoint(raw, [10, 10], scale, false);
    assert.deepEqual(result.point, raw);
    assert.equal(result.ortho, null);
  });

  it("quantises to whole world units", () => {
    assert.deepEqual(snapPoint([37.42, 22.81], null, scale, true).point, [37, 23]);
  });

  it("rounds the half step upward", () => {
    assert.deepEqual(snapPoint([2.5, -2.5], null, scale, true).point, [3, -2]);
  });

  it("locks y to the anchor for a near-horizontal segment", () => {
    // 0.2 world units off the anchor's y is 1px -- inside the band.
    const result = snapPoint([60.4, 20.2], [10, 20], scale, true);
    assert.deepEqual(result.point, [60, 20]);
    assert.equal(result.ortho, "x");
  });

  it("locks x to the anchor for a near-vertical segment", () => {
    const result = snapPoint([10.2, 60.4], [10, 20], scale, true);
    assert.deepEqual(result.point, [10, 60]);
    assert.equal(result.ortho, "y");
  });

  it("picks the nearer axis when both are in band", () => {
    // dx = 1.0px, dy = 0.5px: the horizontal lock is the closer fit.
    const result = snapPoint([10.2, 20.1], [10, 20], scale, true);
    assert.equal(result.ortho, "x");
    assert.equal(result.point[1], 20);
  });

  it("carries the anchor's exact off-grid coordinate", () => {
    // The anchor came from a loaded file and sits at y = 20.37. An axis-aligned
    // edge has to reach that value exactly; the grid alone would give 20.
    const result = snapPoint([60.4, 20.5], [10, 20.37], scale, true);
    assert.equal(result.ortho, "x");
    assert.equal(result.point[1], 20.37);
    assert.equal(result.point[0], 60);
  });

  it("leaves an off-axis point on the grid", () => {
    const result = snapPoint([60.4, 44.7], [10, 20], scale, true);
    assert.deepEqual(result.point, [60, 45]);
    assert.equal(result.ortho, null);
  });

  it("does not lock without an anchor", () => {
    assert.equal(snapPoint([60.4, 20.2], null, scale, true).ortho, null);
  });

  it("measures the band on screen, not in world units", () => {
    // A 2-unit offset is 10px at 5px/unit -- outside the band -- but only 2px
    // once the viewport shrinks to 1px/unit, so the same gesture locks there.
    assert.equal(snapPoint([60, 22], [10, 20], 5, true).ortho, null);
    assert.equal(snapPoint([60, 22], [10, 20], 1, true).ortho, "x");
  });
});

describe("labelStep", () => {
  it("labels every 10 when there is room", () => {
    assert.equal(labelStep(6), 10);
  });

  it("thins to 20 and then 50 as the scale falls", () => {
    assert.equal(labelStep(2), 20);
    assert.equal(labelStep(0.9), 50);
  });

  it("never goes finer than the major grid", () => {
    assert.equal(labelStep(100), 10);
  });
});

describe("pointSegmentDistance", () => {
  it("measures to the segment, not to its supporting line", () => {
    // Level with the segment but well past its end: the line would say zero.
    assert.equal(pointSegmentDistance([10, 0], [0, 0], [1, 0]), 9);
    assert.equal(pointSegmentDistance([-4, 0], [0, 0], [1, 0]), 4);
  });

  it("measures the perpendicular for a point beside the segment", () => {
    assert.equal(pointSegmentDistance([0.5, 2], [0, 0], [1, 0]), 2);
  });

  it("treats a degenerate segment as the point it is", () => {
    assert.equal(pointSegmentDistance([3, 4], [0, 0], [0, 0]), 5);
  });
});

describe("pickEdge", () => {
  const t = computeTransform(800, 600);
  const square: Point[] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  const loops = [{ key: "boundary" as const, loop: square }];

  it("picks the edge under the pointer", () => {
    // Midpoint of the bottom edge, which runs [0,0] -> [100,0].
    assert.deepEqual(pickEdge(toScreen([50, 0], t), loops, t), {
      key: "boundary",
      edge: 0,
    });

    // Midpoint of the left edge, which is the implicit closing edge.
    assert.deepEqual(pickEdge(toScreen([0, 50], t), loops, t), {
      key: "boundary",
      edge: 3,
    });
  });

  it("returns null outside the tolerance band", () => {
    assert.equal(pickEdge(toScreen([50, 50], t), loops, t), null);
  });

  it("measures the band in screen pixels, not world units", () => {
    const [x, onEdge] = toScreen([50, 0], t);
    const [, nearby] = toScreen([50, 1], t);
    assert.ok(Math.abs(onEdge - nearby) > 2, "the probe must clear the tight band");

    assert.equal(pickEdge([x, nearby], loops, t, 2), null);
    assert.deepEqual(pickEdge([x, nearby], loops, t, 20), { key: "boundary", edge: 0 });
  });

  it("searches every loop", () => {
    const hole: Point[] = [
      [40, 40],
      [60, 40],
      [60, 60],
    ];
    const both = [...loops, { key: "hole:0" as const, loop: hole }];
    assert.deepEqual(pickEdge(toScreen([50, 40], t), both, t), {
      key: "hole:0",
      edge: 0,
    });
  });

  it("breaks ties toward the earlier loop", () => {
    // A duplicate of the boundary under a later key must not steal from it,
    // or which edge a click selects would depend on iteration order.
    const duplicated = [...loops, { key: "hole:0" as const, loop: square }];
    assert.deepEqual(pickEdge(toScreen([50, 0], t), duplicated, t), {
      key: "boundary",
      edge: 0,
    });
  });
});
