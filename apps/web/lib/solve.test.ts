import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSolveGeometry,
  conditionFor,
  DEFAULT_CONDITION,
  loopEntries,
  NO_CONDITIONS,
  reconcileConditions,
  solveRequestKey,
  subdivisionsFor,
  toSpec,
  type BoundaryConditions,
  type ConditionValue,
  type SolveRequest,
} from "./solve.ts";
import type { Loop } from "./mesh.ts";

const SQUARE: Loop = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const HOLE: Loop = [
  [4, 4],
  [6, 4],
  [6, 6],
];

const dirichlet = (value: number): ConditionValue => ({
  kind: "dirichlet",
  value,
  coefficient: 1,
});

function baseRequest(): SolveRequest {
  const geometry = buildSolveGeometry(SQUARE, [], NO_CONDITIONS);
  return {
    vertices: [0, 0, 1, 0, 0, 1],
    triangles: [0, 1, 2],
    ...geometry,
    conductivity: 1,
    source: { kind: "constant", value: 0 },
    degree: 1,
    tolerance: 1e-10,
    max_iterations: 5000,
    subdivisions: 2,
  };
}

describe("solveRequestKey", () => {
  it("is stable for the same problem on the same mesh", () => {
    assert.equal(
      solveRequestKey(baseRequest(), "mesh-a"),
      solveRequestKey(baseRequest(), "mesh-a"),
    );
  });

  it("changes when the mesh changes, even though the request has not", () => {
    assert.notEqual(
      solveRequestKey(baseRequest(), "mesh-a"),
      solveRequestKey(baseRequest(), "mesh-b"),
    );
  });

  it("changes when any solve parameter changes", () => {
    const reference = solveRequestKey(baseRequest(), "mesh-a");

    const mutations: ((request: SolveRequest) => void)[] = [
      (r) => (r.conductivity = 2),
      (r) => (r.source = { kind: "constant", value: 1 }),
      (r) => (r.degree = 2),
      (r) => (r.subdivisions = 3),
      (r) => (r.conditions = [{ kind: "neumann", value: 0 }]),
      (r) => (r.segment_tags = [1, 0, 0, 0]),
      (r) => (r.segments = [0, 0, 1, 1]),
      // Unlike the mesher's key, the effort knobs count here: they change the
      // field that gets drawn, not just how long it took to get there.
      (r) => (r.tolerance = 1e-6),
      (r) => (r.max_iterations = 10),
    ];

    for (const mutate of mutations) {
      const request = baseRequest();
      mutate(request);
      assert.notEqual(
        solveRequestKey(request, "mesh-a"),
        reference,
        `${mutate} did not change the key`,
      );
    }
  });

  it("does not depend on the mesh arrays, which the mesh key already covers", () => {
    const request = baseRequest();
    request.vertices = [9, 9, 9, 9, 9, 9];
    request.triangles = [2, 1, 0];
    assert.equal(solveRequestKey(request, "mesh-a"), solveRequestKey(baseRequest(), "mesh-a"));
  });
});

describe("buildSolveGeometry", () => {
  it("emits one segment per edge, including the implicit closing edge", () => {
    const { segments, segment_tags } = buildSolveGeometry(SQUARE, [HOLE], NO_CONDITIONS);

    assert.equal(segment_tags.length, SQUARE.length + HOLE.length);
    assert.equal(segments.length, segment_tags.length * 4);

    // The last edge of the outer loop wraps back to its first point.
    const last = segments.slice((SQUARE.length - 1) * 4, SQUARE.length * 4);
    assert.deepEqual(last, [0, 10, 0, 0]);
  });

  it("interns identical conditions into one tag", () => {
    const { segment_tags, conditions } = buildSolveGeometry(SQUARE, [HOLE], NO_CONDITIONS);

    assert.equal(conditions.length, 1, "seven identical edges should share one tag");
    assert.ok(segment_tags.every((tag) => tag === 0));
  });

  it("gives distinct conditions distinct tags, and every tag is in range", () => {
    const conditions: BoundaryConditions = {
      loops: { boundary: dirichlet(0), "hole:0": dirichlet(100) },
      edges: { "boundary:1": { kind: "neumann", value: 5, coefficient: 1 } },
    };

    const built = buildSolveGeometry(SQUARE, [HOLE], conditions);

    assert.equal(built.conditions.length, 3);
    assert.ok(
      built.segment_tags.every((tag) => tag >= 0 && tag < built.conditions.length),
      "a tag with no condition would abort the solver",
    );
    // Edge 1 of the boundary is the override; edges 0, 2 and 3 are not.
    assert.notEqual(built.segment_tags[1], built.segment_tags[0]);
    assert.equal(built.segment_tags[0], built.segment_tags[2]);
    // Every hole edge carries the hole's own condition.
    const holeTags = built.segment_tags.slice(SQUARE.length);
    assert.ok(holeTags.every((tag) => tag === holeTags[0]));
    assert.notEqual(holeTags[0], built.segment_tags[0]);
  });

  it("always produces at least one condition, since tag 0 is the fallback", () => {
    const { conditions } = buildSolveGeometry([], [], NO_CONDITIONS);
    assert.equal(conditions.length, 1);
  });
});

describe("toSpec", () => {
  it("drops the coefficient for kinds that do not use it", () => {
    const carried: ConditionValue = { kind: "dirichlet", value: 2, coefficient: 7 };
    assert.deepEqual(toSpec(carried), { kind: "dirichlet", value: 2 });
    assert.deepEqual(toSpec({ ...carried, kind: "neumann" }), { kind: "neumann", value: 2 });
    assert.deepEqual(toSpec({ ...carried, kind: "robin" }), {
      kind: "robin",
      coefficient: 7,
      value: 2,
    });
  });
});

describe("conditionFor", () => {
  const conditions: BoundaryConditions = {
    loops: { boundary: dirichlet(1) },
    edges: { "boundary:2": dirichlet(9) },
  };

  it("prefers an edge override over its loop", () => {
    assert.equal(conditionFor(conditions, "boundary", 2).value, 9);
  });

  it("falls back to the loop, then to the default", () => {
    assert.equal(conditionFor(conditions, "boundary", 0).value, 1);
    assert.deepEqual(conditionFor(conditions, "hole:0", 0), DEFAULT_CONDITION);
  });
});

describe("reconcileConditions", () => {
  const existing: BoundaryConditions = {
    loops: { boundary: dirichlet(1), "hole:0": dirichlet(2) },
    edges: { "boundary:2": dirichlet(9), "hole:0:1": dirichlet(8) },
  };

  it("keeps everything when the geometry is unchanged", () => {
    const next = reconcileConditions(SQUARE, [HOLE], existing);
    assert.deepEqual(next, existing);
  });

  it("drops holes that no longer exist", () => {
    const next = reconcileConditions(SQUARE, [], existing);
    assert.equal(next.loops["hole:0"], undefined);
    assert.equal(next.edges["hole:0:1"], undefined);
    assert.equal(next.loops.boundary?.value, 1);
  });

  it("gives a newly drawn loop the default condition", () => {
    const next = reconcileConditions(SQUARE, [HOLE, HOLE], existing);
    assert.deepEqual(next.loops["hole:1"], DEFAULT_CONDITION);
  });

  it("keeps a loop's condition but drops overrides past a shrunk loop's end", () => {
    // A triangle has edges 0..2, so the override on edge 2 survives; shrink
    // further and it does not.
    const triangle: Loop = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    const kept = reconcileConditions(triangle, [], existing);
    assert.equal(kept.edges["boundary:2"]?.value, 9);
    assert.equal(kept.loops.boundary?.value, 1, "the wall itself is still the same wall");

    const shrunk = reconcileConditions(
      [
        [0, 0],
        [1, 0],
      ],
      [],
      existing,
    );
    assert.equal(shrunk.edges["boundary:2"], undefined);
    assert.equal(shrunk.loops.boundary?.value, 1);
  });

  it("produces nothing at all when no geometry is drawn", () => {
    assert.deepEqual(reconcileConditions(null, [], existing), { loops: {}, edges: {} });
  });
});

describe("loopEntries", () => {
  it("puts the boundary first, then holes in order", () => {
    assert.deepEqual(
      loopEntries(SQUARE, [HOLE]).map((entry) => entry.key),
      ["boundary", "hole:0"],
    );
    assert.deepEqual(loopEntries(null, [HOLE]).map((entry) => entry.key), ["hole:0"]);
  });
});

describe("subdivisionsFor", () => {
  it("tracks the degree, clamped to what the solver accepts", () => {
    assert.equal(subdivisionsFor(1), 1);
    assert.equal(subdivisionsFor(3), 3);
    assert.equal(subdivisionsFor(9), 4);
    assert.equal(subdivisionsFor(0), 1);
  });
});
