import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_GAS_CONDITION,
  blastInitial,
  buildTransientGeometry,
  frameField,
  gasConditionFor,
  machOf,
  rangeOver,
  reconcileGasConditions,
  toGasSpec,
  transientRequestKey,
  type GasConditionValue,
  type GasConditions,
  type TransientFrame,
  type TransientRequest,
  type TransientSetup,
} from "./transient.ts";

const WALLS: GasConditions = { loops: {}, edges: {} };

function condition(patch: Partial<GasConditionValue>): GasConditionValue {
  return { ...DEFAULT_GAS_CONDITION, ...patch };
}

const SQUARE: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe("buildTransientGeometry", () => {
  it("emits one segment per edge, closing every loop", () => {
    const { segments, segment_tags } = buildTransientGeometry(SQUARE, [], WALLS);
    assert.equal(segment_tags.length, 4);
    assert.equal(segments.length, 16);
    // The last edge wraps back to the first point.
    assert.deepEqual(segments.slice(12), [0, 10, 0, 0]);
  });

  it("always defines tag zero, which unclaimed faces fall back to", () => {
    const { conditions } = buildTransientGeometry(null, [], WALLS);
    assert.ok(conditions.length >= 1);
    assert.deepEqual(conditions[0], { kind: "slip_wall" });
  });

  it("interns one condition per distinct choice", () => {
    const walls = buildTransientGeometry(SQUARE, [SQUARE], WALLS);
    // Both loops are walls, so both share tag 0 and nothing else is emitted.
    assert.equal(walls.conditions.length, 1);
    assert.deepEqual(new Set(walls.segment_tags), new Set([0]));

    const mixed = buildTransientGeometry(SQUARE, [SQUARE], {
      loops: { boundary: condition({ kind: "open" }) },
      edges: {},
    });
    assert.equal(mixed.conditions.length, 2);
    assert.equal(mixed.segment_tags[0], 1, "the outline should take the new tag");
    assert.equal(mixed.segment_tags[4], 0, "the hole should stay a wall");
  });

  it("gives a single edge its own tag without disturbing its loop", () => {
    const { segment_tags, conditions } = buildTransientGeometry(SQUARE, [], {
      loops: {},
      edges: { "boundary:2": condition({ kind: "outflow", pressure: 0.6 }) },
    });

    assert.equal(conditions.length, 2, "one wall and one outflow");
    assert.deepEqual(segment_tags, [0, 0, 1, 0]);
    assert.deepEqual(conditions[1], { kind: "outflow", pressure: 0.6 });
  });

  it("costs nothing on the wire when every edge of a loop agrees", () => {
    const perLoop = buildTransientGeometry(SQUARE, [], {
      loops: { boundary: condition({ kind: "open" }) },
      edges: {},
    });
    const perEdge = buildTransientGeometry(SQUARE, [], {
      loops: {},
      edges: Object.fromEntries(
        [0, 1, 2, 3].map((edge) => [`boundary:${edge}`, condition({ kind: "open" })]),
      ),
    });
    assert.deepEqual(perLoop.conditions, perEdge.conditions);
    assert.deepEqual(perLoop.segment_tags, perEdge.segment_tags);
  });

  it("treats an unstated edge as a wall", () => {
    assert.equal(gasConditionFor(WALLS, "boundary", 0).kind, "wall");
  });

  it("prefers an edge override to its loop", () => {
    const conditions: GasConditions = {
      loops: { boundary: condition({ kind: "open" }) },
      edges: { "boundary:1": condition({ kind: "outflow", pressure: 2 }) },
    };
    assert.equal(gasConditionFor(conditions, "boundary", 0).kind, "open");
    assert.equal(gasConditionFor(conditions, "boundary", 1).kind, "outflow");
  });
});

describe("toGasSpec", () => {
  it("drops the fields a kind does not use", () => {
    assert.deepEqual(toGasSpec(condition({ kind: "wall" })), { kind: "slip_wall" });
    assert.deepEqual(toGasSpec(condition({ kind: "open" })), { kind: "transmissive" });
    assert.deepEqual(toGasSpec(condition({ kind: "outflow", pressure: 3 })), {
      kind: "outflow",
      pressure: 3,
    });
  });

  it("keeps an inflow's state and schedule through a change of kind and back", () => {
    // The bug this type exists to prevent: the editor holds every field for
    // every kind, so switching away and back cannot lose what was typed.
    const typed = condition({
      kind: "inflow",
      state: { density: 2, velocity: [5, 1], pressure: 3 },
      schedule: { kind: "ramp", over: 4 },
    });
    const wall: GasConditionValue = { ...typed, kind: "wall" };
    const back: GasConditionValue = { ...wall, kind: "inflow" };

    assert.deepEqual(toGasSpec(back), {
      kind: "inflow",
      state: { density: 2, velocity: [5, 1], pressure: 3 },
      schedule: { kind: "ramp", over: 4 },
    });
  });
});

describe("reconcileGasConditions", () => {
  it("materialises every loop and keeps only the overrides that still exist", () => {
    const previous: GasConditions = {
      loops: { boundary: condition({ kind: "open" }), "hole:0": condition({ kind: "wall" }) },
      edges: {
        "boundary:1": condition({ kind: "outflow", pressure: 2 }),
        // An edge index past the end of a loop that has since shrunk.
        "boundary:9": condition({ kind: "open" }),
        // A hole that has since been deleted.
        "hole:0:0": condition({ kind: "open" }),
      },
    };

    const reconciled = reconcileGasConditions(SQUARE, [], previous);
    assert.equal(reconciled.loops.boundary?.kind, "open");
    assert.equal(reconciled.loops["hole:0"], undefined, "a deleted hole keeps no loop entry");
    assert.ok(reconciled.edges["boundary:1"], "a live override survives");
    assert.equal(reconciled.edges["boundary:9"], undefined, "a stale edge index is dropped");
    assert.equal(reconciled.edges["hole:0:0"], undefined, "a deleted hole's edges go with it");
  });

  it("gives an unstated loop the default rather than leaving it undefined", () => {
    const reconciled = reconcileGasConditions(SQUARE, [], { loops: {}, edges: {} });
    assert.deepEqual(reconciled.loops.boundary, DEFAULT_GAS_CONDITION);
  });
});

describe("machOf", () => {
  it("is the speed over the sound speed", () => {
    // c = sqrt(1.4 * 1 / 1) ~ 1.1832; |v| = 3
    assert.ok(Math.abs(machOf({ density: 1, velocity: [3, 0], pressure: 1 }) - 2.5355) < 1e-3);
  });

  it("uses the whole velocity, not one component", () => {
    const diagonal = machOf({ density: 1, velocity: [3, 4], pressure: 1 });
    const along = machOf({ density: 1, velocity: [5, 0], pressure: 1 });
    assert.ok(Math.abs(diagonal - along) < 1e-12);
  });

  it("reports rest as zero rather than as not a number", () => {
    assert.equal(machOf({ density: 1, velocity: [0, 0], pressure: 1 }), 0);
  });
});

describe("rangeOver", () => {
  const frame = (min: number, max: number): TransientFrame => ({
    index: 0,
    time: 0,
    values: new Float32Array(0),
    vectors: new Float32Array(0),
    min,
    max,
    fastest: 0,
  });

  it("spans every frame, not the last one", () => {
    assert.deepEqual(rangeOver([frame(1, 4), frame(0, 2), frame(3, 9)]), { min: 0, max: 9 });
  });

  it("gives a usable range for a field with no variation", () => {
    const { min, max } = rangeOver([frame(2, 2)]);
    assert.ok(max > min, "a flat field still needs a range the ramp can divide by");
  });

  it("gives a usable range before any frame has arrived", () => {
    const { min, max } = rangeOver([]);
    assert.ok(Number.isFinite(min) && Number.isFinite(max) && max > min);
  });
});

describe("frameField", () => {
  const setup: TransientSetup = {
    sub_triangles: [0, 1, 2],
    sample_stride: 3,
    subdivisions: 1,
    element_count: 2,
    mode_count: 3,
    degree: 1,
    frames: 2,
    unclassified_faces: 0,
    worst_match_distance: 0,
  };
  const positions = new Float32Array(12);

  it("draws every frame against the run's range, not its own", () => {
    const range = { min: 0, max: 10 };
    const early = frameField(setup, positions, { index: 0, time: 0, values: new Float32Array(6), vectors: new Float32Array(4), min: 9, max: 10, fastest: 0 }, range);
    const late = frameField(setup, positions, { index: 1, time: 1, values: new Float32Array(6), vectors: new Float32Array(4), min: 0, max: 1, fastest: 0 }, range);

    assert.equal(early.min_value, 0);
    assert.equal(early.max_value, 10);
    assert.equal(late.min_value, 0);
    assert.equal(late.max_value, 10);
  });

  it("gives each frame an identity, so a cached raster is not reused for the next", () => {
    const range = { min: 0, max: 1 };
    const first = frameField(setup, positions, { index: 0, time: 0, values: new Float32Array(6), vectors: new Float32Array(4), min: 0, max: 1, fastest: 0 }, range);
    const second = frameField(setup, positions, { index: 1, time: 1, values: new Float32Array(6), vectors: new Float32Array(4), min: 0, max: 1, fastest: 0 }, range);
    assert.notEqual(first.identity, second.identity);
  });

  it("shares one positions array across every frame", () => {
    const range = { min: 0, max: 1 };
    const first = frameField(setup, positions, { index: 0, time: 0, values: new Float32Array(6), vectors: new Float32Array(4), min: 0, max: 1, fastest: 0 }, range);
    const second = frameField(setup, positions, { index: 1, time: 1, values: new Float32Array(6), vectors: new Float32Array(4), min: 0, max: 1, fastest: 0 }, range);
    assert.equal(first.positions, second.positions);
  });
});

describe("transientRequestKey", () => {
  const request: TransientRequest = {
    vertices: [0, 0, 1, 0, 0, 1],
    triangles: [0, 1, 2],
    segments: [],
    segment_tags: [],
    conditions: [{ kind: "slip_wall" }],
    initial: blastInitial([50, 50], 10, 10),
    gamma: 1.4,
    degree: 1,
    end_time: 30,
    frames: 60,
    cfl: 0.3,
    limiter: 0,
    subdivisions: 2,
    field: "density",
  };

  it("is stable for the same problem", () => {
    assert.equal(transientRequestKey(request, "m1"), transientRequestKey({ ...request }, "m1"));
  });

  it("separates problems that differ only in what is drawn", () => {
    assert.notEqual(
      transientRequestKey(request, "m1"),
      transientRequestKey({ ...request, field: "pressure" }, "m1"),
    );
    assert.notEqual(transientRequestKey(request, "m1"), transientRequestKey(request, "m2"));
  });

  it("ignores the mesh arrays, which the mesh key already identifies", () => {
    assert.equal(
      transientRequestKey(request, "m1"),
      transientRequestKey({ ...request, vertices: [9, 9], triangles: [7, 7, 7] }, "m1"),
    );
  });
});
