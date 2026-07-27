import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseGeometryJson,
  toGeometryJson,
  toGmsh,
  toVtk,
  toVtkField,
} from "./export.ts";
import {
  loopCornerAngles,
  meshRequestKey,
  selfIntersects,
  signedArea,
  validateLoop,
} from "./mesh.ts";
import type { MeshResponse } from "./mesh.ts";
import type { SolveResponse } from "./solve.ts";

/** A unit square as two triangles sharing the diagonal 0-2. */
function unitSquareMesh(): MeshResponse {
  return {
    vertices: [0, 0, 1, 0, 1, 1, 0, 1],
    triangles: [0, 1, 2, 0, 2, 3],
    min_angles_deg: [45, 45],
    vertex_count: 4,
    triangle_count: 2,
    min_angle_deg: 45,
    angle_histogram: [],
    terminated_early: false,
    unimprovable_elements: 0,
    outcome: "converged",
    provable_termination: true,
  };
}

describe("Gmsh export", () => {
  const lines = toGmsh(unitSquareMesh()).split("\n");

  it("declares the right counts", () => {
    assert.equal(lines[lines.indexOf("$Nodes") + 1], "4");
    assert.equal(lines[lines.indexOf("$Elements") + 1], "2");
  });

  it("numbers nodes from 1, not 0", () => {
    // The single most common way a Gmsh file written from a 0-based index
    // buffer is silently wrong: readers accept it and drop or mis-wire an
    // element.
    const start = lines.indexOf("$Elements") + 2;
    const referenced = lines
      .slice(start, start + 2)
      .flatMap((line) => line.split(" ").slice(5).map(Number));

    assert.equal(Math.min(...referenced), 1);
    assert.equal(Math.max(...referenced), 4);
  });

  it("writes 3-node triangles with 2 tags", () => {
    const first = lines[lines.indexOf("$Elements") + 2].split(" ");
    assert.equal(first[1], "2", "element type 2 is the 3-node triangle");
    assert.equal(first[2], "2", "tag count");
    assert.equal(first.length, 8, "id + type + ntags + 2 tags + 3 nodes");
  });

  it("pads planar coordinates to 3D", () => {
    const first = lines[lines.indexOf("$Nodes") + 2].split(" ");
    assert.equal(first.length, 4);
    assert.equal(first[3], "0");
  });
});

describe("VTK export", () => {
  const text = toVtk(unitSquareMesh());
  const lines = text.split("\n");

  it("sizes the CELLS block including each leading count", () => {
    // The other classic off-by-one: the size field is 4 per triangle (the
    // count plus three ids), not 3. ParaView rejects the file otherwise.
    const cells = lines.find((line) => line.startsWith("CELLS"))!;
    const [, count, size] = cells.split(" ").map(Number);
    assert.equal(count, 2);
    assert.equal(size, count * 4);
  });

  it("marks every cell as VTK_TRIANGLE", () => {
    const start = lines.indexOf("CELL_TYPES 2") + 1;
    assert.deepEqual(lines.slice(start, start + 2), ["5", "5"]);
  });

  it("carries the per-element quality field", () => {
    assert.match(text, /SCALARS min_angle_deg double 1/);
    assert.match(text, /LOOKUP_TABLE default/);
  });
});

describe("geometry document", () => {
  it("round-trips", () => {
    const document = {
      version: 1 as const,
      boundary: [
        [0, 0],
        [1, 0],
        [1, 1],
      ] as [number, number][],
      holes: [],
      minAngleDeg: 25,
      maxAreaPercent: 1,
    };

    const parsed = parseGeometryJson(toGeometryJson(document));
    assert.notEqual(typeof parsed, "string");
    assert.deepEqual((parsed as typeof document).boundary, document.boundary);
  });

  it("reports a reason instead of throwing on bad input", () => {
    // This is fed by a file the user picked, so a bad pick has to become a
    // message rather than an exception that blanks the page.
    assert.equal(typeof parseGeometryJson("{{{"), "string");
    assert.equal(typeof parseGeometryJson('{"boundary":[[1,"x"]]}'), "string");
    assert.equal(typeof parseGeometryJson('{"boundary":[[1,2,3]]}'), "string");
    assert.equal(typeof parseGeometryJson("[]"), "string");
  });
});

describe("geometry validation", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  it("measures signed area with orientation", () => {
    assert.equal(signedArea(square), 1);
    assert.equal(signedArea([...square].reverse()), -1);
  });

  it("accepts a simple polygon", () => {
    assert.equal(validateLoop(square, "The boundary"), null);
    assert.equal(selfIntersects(square), false);
  });

  it("rejects a self-intersecting polygon", () => {
    // A bow-tie: the two diagonals cross.
    const bowTie: [number, number][] = [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ];
    assert.equal(selfIntersects(bowTie), true);
    assert.match(String(validateLoop(bowTie, "The boundary")), /intersects itself/);
  });

  it("rejects degenerate loops", () => {
    assert.match(String(validateLoop([[0, 0]], "The boundary")), /at least 3/);
    assert.match(
      String(
        validateLoop(
          [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
          "The boundary",
        ),
      ),
      /encloses no area/,
    );
  });

  it("computes interior corner angles", () => {
    const angles = loopCornerAngles(square);
    assert.equal(angles.length, 4);
    for (const angle of angles) {
      assert.ok(Math.abs(angle - 90) < 1e-9, `expected 90 degrees, got ${angle}`);
    }
  });
});

describe("mesh request identity", () => {
  const base = {
    boundary: [
      [0, 0],
      [1, 0],
      [1, 1],
    ] as [number, number][],
    holes: [],
    min_angle_deg: 25,
    max_area: 0.5,
  };

  it("is stable for identical requests", () => {
    assert.equal(meshRequestKey(base), meshRequestKey({ ...base }));
  });

  it("changes when the geometry changes", () => {
    assert.notEqual(
      meshRequestKey(base),
      meshRequestKey({
        ...base,
        boundary: [
          [0, 0],
          [2, 0],
          [2, 2],
        ],
      }),
    );
    assert.notEqual(
      meshRequestKey(base),
      meshRequestKey({
        ...base,
        holes: [
          [
            [0.2, 0.2],
            [0.4, 0.2],
            [0.4, 0.4],
          ],
        ],
      }),
    );
  });

  it("changes when the quality target changes", () => {
    assert.notEqual(meshRequestKey(base), meshRequestKey({ ...base, min_angle_deg: 20 }));
    assert.notEqual(meshRequestKey(base), meshRequestKey({ ...base, max_area: 0.25 }));
  });

  it("ignores the effort caps", () => {
    // These bound how hard the mesher tries, not what is being meshed, so
    // changing one must not mark an existing mesh as describing the wrong
    // geometry.
    assert.equal(
      meshRequestKey(base),
      meshRequestKey({ ...base, max_steps: 999, max_triangles: 123 }),
    );
  });

  it("distinguishes an absent area bound from a present one", () => {
    assert.notEqual(meshRequestKey(base), meshRequestKey({ ...base, max_area: null }));
  });
});

/** Two elements, each sampled on the n=1 lattice: 3 points, 1 sub-triangle. */
function twoElementField(): SolveResponse {
  return {
    positions: [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1],
    values: [1, 2, 3, 4, 5, 6],
    sub_triangles: [0, 1, 2],
    sample_stride: 3,
    subdivisions: 1,
    element_count: 2,
    mode_count: 3,
    degree: 1,
    min_value: 1,
    max_value: 6,
    iterations: 10,
    residual_norm: 1e-12,
    initial_norm: 1,
    converged: true,
    singular: false,
    unclassified_faces: 0,
    worst_match_distance: 0,
  };
}

describe("solution VTK export", () => {
  const lines = toVtkField(twoElementField()).split("\n");

  it("writes one point per element per lattice point, not per mesh node", () => {
    // The duplication along shared edges is the point: a discontinuous field
    // has no single value at a shared node, and averaging to get one would
    // smooth away the jumps the method exists to represent.
    assert.equal(lines[lines.indexOf("POINTS 6 double")], "POINTS 6 double");
    assert.equal(lines[lines.indexOf("POINT_DATA 6")], "POINT_DATA 6");
  });

  it("offsets the shared sub-triangle list into each element's own points", () => {
    const start = lines.indexOf("CELLS 2 8");
    assert.notEqual(start, -1, "cell count and size header");
    assert.equal(lines[start + 1], "3 0 1 2");
    assert.equal(lines[start + 2], "3 3 4 5", "the second element must not reuse element 0's points");
  });

  it("carries every sampled value as point data", () => {
    const start = lines.indexOf("LOOKUP_TABLE default");
    assert.deepEqual(lines.slice(start + 1, start + 7), ["1", "2", "3", "4", "5", "6"]);
  });

  it("declares one triangle cell type per sub-triangle", () => {
    const start = lines.indexOf("CELL_TYPES 2");
    assert.deepEqual(lines.slice(start + 1, start + 3), ["5", "5"]);
  });
});
