import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoWarpScale,
  buildElasticGeometry,
  DEFAULT_ELASTIC_CONDITION,
  deriveField,
  elasticConditionFor,
  elasticRequestKey,
  holdsDisplacement,
  NO_ELASTIC_CONDITIONS,
  principalStresses,
  reconcileElasticConditions,
  stressAt,
  toElasticSpec,
  vonMises,
  type ElasticConditions,
  type ElasticConditionValue,
  type ElasticRequest,
  type ElasticResponse,
} from "./elastic.ts";
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

const condition = (
  partial: Partial<ElasticConditionValue>,
): ElasticConditionValue => ({
  ...DEFAULT_ELASTIC_CONDITION,
  ...partial,
});

describe("conditions", () => {
  it("falls back from an edge to its loop to the default", () => {
    const conditions: ElasticConditions = {
      loops: { boundary: condition({ kind: "fixed" }) },
      edges: { "boundary:2": condition({ kind: "traction", x: 0, y: -5 }) },
    };

    assert.equal(elasticConditionFor(conditions, "boundary", 0).kind, "fixed");
    assert.equal(elasticConditionFor(conditions, "boundary", 2).kind, "traction");
    // A loop nobody has touched gets the default, not the boundary's.
    assert.equal(
      elasticConditionFor(conditions, "hole:0", 0).kind,
      DEFAULT_ELASTIC_CONDITION.kind,
    );
  });

  it("keeps a loop condition through a redraw and drops out-of-range edges", () => {
    const previous: ElasticConditions = {
      loops: { boundary: condition({ kind: "fixed" }) },
      edges: {
        "boundary:1": condition({ kind: "traction", x: 1, y: 0 }),
        "boundary:9": condition({ kind: "traction", x: 2, y: 0 }),
      },
    };

    const reconciled = reconcileElasticConditions(SQUARE, [], previous);

    assert.equal(reconciled.loops.boundary?.kind, "fixed");
    assert.equal(reconciled.edges["boundary:1"]?.x, 1);
    assert.equal(
      reconciled.edges["boundary:9"],
      undefined,
      "an override past the loop's last edge names an edge that no longer exists",
    );
  });

  it("gives a newly drawn hole the default condition", () => {
    const reconciled = reconcileElasticConditions(SQUARE, [HOLE], NO_ELASTIC_CONDITIONS);
    assert.equal(reconciled.loops["hole:0"]?.kind, DEFAULT_ELASTIC_CONDITION.kind);
  });

  it("knows which kinds hold displacement", () => {
    assert.equal(holdsDisplacement("fixed"), true);
    assert.equal(holdsDisplacement("roller_x"), true);
    assert.equal(holdsDisplacement("spring"), true);
    assert.equal(holdsDisplacement("displacement"), true);
    assert.equal(holdsDisplacement("free"), false);
    assert.equal(holdsDisplacement("traction"), false);
    assert.equal(holdsDisplacement("force"), false);
  });
});

describe("toElasticSpec", () => {
  it("drops the fields a kind does not use", () => {
    assert.deepEqual(toElasticSpec(condition({ kind: "fixed", x: 7, y: 7 }), 1), {
      kind: "fixed",
    });
    assert.deepEqual(toElasticSpec(condition({ kind: "roller_x", x: 7 }), 1), {
      kind: "roller_x",
    });
    assert.deepEqual(
      toElasticSpec(condition({ kind: "spring", stiffness: 12, x: 7 }), 1),
      { kind: "spring", stiffness: 12 },
    );
  });

  it("attaches the edge length to a total force and nothing else", () => {
    assert.deepEqual(toElasticSpec(condition({ kind: "force", x: 0, y: -100 }), 0.25), {
      kind: "force",
      x: 0,
      y: -100,
      length: 0.25,
    });
    assert.deepEqual(toElasticSpec(condition({ kind: "traction", x: 0, y: -4 }), 0.25), {
      kind: "traction",
      x: 0,
      y: -4,
    });
  });
});

describe("buildElasticGeometry", () => {
  it("interns identical conditions into one tag", () => {
    const geometry = buildElasticGeometry(SQUARE, [], {
      loops: { boundary: condition({ kind: "free" }) },
      edges: { "boundary:0": condition({ kind: "fixed" }) },
    });

    assert.equal(geometry.segments.length, 4 * 4, "four edges, four numbers each");
    assert.equal(geometry.conditions.length, 2, "fixed and free, not four entries");
    assert.deepEqual(geometry.segment_tags, [0, 1, 1, 1]);
  });

  it("measures each edge so a total force becomes the right traction", () => {
    // A 10 x 10 square: every edge is 10 long.
    const geometry = buildElasticGeometry(SQUARE, [], {
      loops: { boundary: condition({ kind: "force", x: 0, y: -50 }) },
      edges: {},
    });

    assert.equal(geometry.conditions.length, 1);
    assert.deepEqual(geometry.conditions[0], {
      kind: "force",
      x: 0,
      y: -50,
      length: 10,
    });
  });

  it("keeps equal forces over unequal edges apart", () => {
    // The right triangle's legs are both 2 long and its hypotenuse is 2*sqrt(2),
    // so the same total force spreads to two different tractions -- and the two
    // legs, which really do agree, still share one tag.
    const geometry = buildElasticGeometry(null, [HOLE], {
      loops: { "hole:0": condition({ kind: "force", x: 1, y: 0 }) },
      edges: {},
    });

    assert.equal(
      geometry.conditions.length,
      2,
      "two distinct edge lengths means two distinct tractions",
    );
    assert.deepEqual(geometry.segment_tags, [0, 0, 1]);
  });

  it("always emits a tag zero for faces no edge claims", () => {
    const geometry = buildElasticGeometry(null, [], NO_ELASTIC_CONDITIONS);
    assert.equal(geometry.segments.length, 0);
    assert.deepEqual(geometry.conditions, [{ kind: "free" }]);
  });
});

describe("elasticRequestKey", () => {
  function request(): ElasticRequest {
    return {
      vertices: [0, 0, 1, 0, 0, 1],
      triangles: [0, 1, 2],
      ...buildElasticGeometry(SQUARE, [], NO_ELASTIC_CONDITIONS),
      youngs_modulus: 210,
      poisson_ratio: 0.3,
      plane: "stress",
      body_force: [0, 0],
      degree: 2,
      tolerance: 1e-10,
      max_iterations: 20000,
      subdivisions: 2,
    };
  }

  it("separates problems that differ in the material", () => {
    const a = request();
    const b = { ...request(), poisson_ratio: 0.35 };
    assert.notEqual(elasticRequestKey(a, "mesh"), elasticRequestKey(b, "mesh"));
  });

  it("separates the two plane states", () => {
    const a = request();
    const b: ElasticRequest = { ...request(), plane: "strain" };
    assert.notEqual(elasticRequestKey(a, "mesh"), elasticRequestKey(b, "mesh"));
  });

  it("separates problems solved on different meshes", () => {
    const a = request();
    assert.notEqual(elasticRequestKey(a, "mesh-1"), elasticRequestKey(a, "mesh-2"));
  });

  it("matches for the same problem", () => {
    assert.equal(
      elasticRequestKey(request(), "mesh"),
      elasticRequestKey(request(), "mesh"),
    );
  });
});

/**
 * A material with round numbers, so the expected stresses can be worked out by
 * hand rather than by rerunning the code being tested.
 *
 * lambda = 1, mu = 1 gives sigma_xx = (exx + eyy) + 2 exx.
 */
const MATERIAL = {
  lambda: 1,
  mu: 1,
  poisson_ratio: 0.25,
  plane: "stress" as const,
};

describe("stressAt", () => {
  it("applies Hooke's law with the tensor shear", () => {
    const stress = stressAt(MATERIAL, 2, 1, 0.5);
    assert.equal(stress.xx, 3 + 4, "lambda tr + 2 mu exx");
    assert.equal(stress.yy, 3 + 2);
    assert.equal(stress.xy, 1, "2 mu eps_xy, i.e. mu gamma_xy");
  });

  it("leaves the out-of-plane stress at zero in plane stress", () => {
    assert.equal(stressAt(MATERIAL, 2, 1, 0).zz, 0);
  });

  it("carries an out-of-plane stress in plane strain", () => {
    const strain = { ...MATERIAL, plane: "strain" as const };
    const stress = stressAt(strain, 2, 1, 0);
    assert.equal(stress.zz, 0.25 * (stress.xx + stress.yy));
    assert.notEqual(stress.zz, 0);
  });
});

describe("vonMises", () => {
  it("equals the stress itself for a uniaxial state", () => {
    const stress = { xx: 7, yy: 0, xy: 0, zz: 0 };
    assert.ok(Math.abs(vonMises(stress) - 7) < 1e-12);
  });

  it("equals sqrt(3) times a pure shear", () => {
    const stress = { xx: 0, yy: 0, xy: 4, zz: 0 };
    assert.ok(Math.abs(vonMises(stress) - Math.sqrt(3) * 4) < 1e-12);
  });

  it("vanishes under hydrostatic pressure", () => {
    assert.ok(vonMises({ xx: -9, yy: -9, xy: 0, zz: -9 }) < 1e-12);
  });

  /**
   * The case that matters, and the one a plane-stress shortcut gets wrong. A
   * plane-strain state near incompressibility is almost purely deviatoric, so
   * ignoring `szz` overstates the von Mises stress by a large factor.
   */
  it("differs between the plane states, and increasingly so near nu = 0.5", () => {
    const strains: [number, number, number] = [1e-3, 0, 0];

    const modest = { lambda: 1, mu: 1, poisson_ratio: 0.25, plane: "strain" as const };
    const flat = { ...modest, plane: "stress" as const };
    assert.notEqual(
      vonMises(stressAt(modest, ...strains)),
      vonMises(stressAt(flat, ...strains)),
    );

    // At nu -> 0.5 the plane-strain answer collapses toward the deviatoric part,
    // so the gap between the two readings widens.
    const nearly = { lambda: 100, mu: 1, poisson_ratio: 0.495, plane: "strain" as const };
    const nearlyFlat = { ...nearly, plane: "stress" as const };
    const ratio =
      vonMises(stressAt(nearlyFlat, ...strains)) / vonMises(stressAt(nearly, ...strains));
    assert.ok(ratio > 10, `plane stress overstates by ${ratio}, expected far more than 10`);
  });
});

describe("principalStresses", () => {
  it("returns the diagonal itself when there is no shear", () => {
    const { major, minor, shear } = principalStresses({ xx: 5, yy: -2, xy: 0, zz: 0 });
    assert.equal(major, 5);
    assert.equal(minor, -2);
    assert.equal(shear, 3.5, "half the difference");
  });

  it("rotates a pure shear onto its diagonal", () => {
    const { major, minor, shear } = principalStresses({ xx: 0, yy: 0, xy: 3, zz: 0 });
    assert.equal(major, 3);
    assert.equal(minor, -3);
    assert.equal(shear, 3);
  });
});

/** Two sample points, so every branch of `deriveField` has something to chew. */
function response(): ElasticResponse {
  return {
    positions: [0, 0, 1, 0],
    displacements: [3, 4, -1, 0],
    // (exx, eyy, exy) per point.
    strains: [2, 1, 0.5, 0, 0, 0],
    sub_triangles: [0, 1, 2],
    sample_stride: 2,
    subdivisions: 1,
    element_count: 1,
    mode_count: 3,
    degree: 1,
    lambda: 1,
    mu: 1,
    poisson_ratio: 0.25,
    plane: "stress",
    largest_displacement: 5,
    extent: 10,
    iterations: 12,
    residual_norm: 1e-12,
    initial_norm: 1,
    converged: true,
    unclassified_faces: 0,
    worst_match_distance: 0,
  };
}

describe("deriveField", () => {
  it("computes the displacement magnitude and its range", () => {
    const field = deriveField(response(), "magnitude");
    assert.deepEqual(Array.from(field.values), [5, 1]);
    assert.equal(field.min_value, 1);
    assert.equal(field.max_value, 5);
  });

  it("reads the components straight out", () => {
    assert.deepEqual(Array.from(deriveField(response(), "ux").values), [3, -1]);
    assert.deepEqual(Array.from(deriveField(response(), "uy").values), [4, 0]);
    assert.deepEqual(Array.from(deriveField(response(), "exx").values), [2, 0]);
    assert.deepEqual(Array.from(deriveField(response(), "exy").values), [0.5, 0]);
  });

  it("derives stress through Hooke's law", () => {
    // lambda = mu = 1: sxx = (2 + 1) + 2*2 = 7, sxy = 2*1*0.5 = 1.
    assert.deepEqual(Array.from(deriveField(response(), "sxx").values), [7, 0]);
    assert.deepEqual(Array.from(deriveField(response(), "sxy").values), [1, 0]);
  });

  it("computes the strain energy density with the shear counted twice", () => {
    // sigma = (7, 5, 1), eps = (2, 1, 0.5): (7*2 + 5*1 + 2*1*0.5) / 2 = 10.
    assert.deepEqual(Array.from(deriveField(response(), "energy").values), [10, 0]);
  });

  it("carries the displacements through for the renderer to warp by", () => {
    const field = deriveField(response(), "von_mises");
    assert.deepEqual(Array.from(field.displacements ?? []), [3, 4, -1, 0]);
    assert.equal(field.sample_stride, 2);
    assert.equal(field.element_count, 1);
  });

  it("survives a field that is zero everywhere", () => {
    const flat = response();
    flat.displacements = [0, 0, 0, 0];
    flat.strains = [0, 0, 0, 0, 0, 0];
    const field = deriveField(flat, "von_mises");
    assert.equal(field.min_value, 0);
    assert.equal(field.max_value, 0);
  });
});

describe("autoWarpScale", () => {
  it("opens a tiny deformation to a readable fraction of the part", () => {
    // 5% of 10 is 0.5, against a movement of 1e-4: 5000.
    assert.equal(autoWarpScale(1e-4, 10), 5000);
  });

  it("rounds to one significant figure so the number reads like a choice", () => {
    // 0.5 / 1.873e-4 is 2669.5, which nobody would put beside a slider.
    assert.equal(autoWarpScale(1.873e-4, 10), 3000);
  });

  it("never rounds down to zero", () => {
    // 0.5 / 0.4 is 1.25, and rounding that to the nearest whole number of its
    // own magnitude gives 1 rather than 0 -- a zero warp would draw the
    // undeformed part and look like a solver that returned nothing.
    assert.equal(autoWarpScale(0.4, 10), 1);
    assert.ok(autoWarpScale(100, 10) > 0);
  });

  it("falls back to unity rather than dividing by zero", () => {
    assert.equal(autoWarpScale(0, 10), 1);
    assert.equal(autoWarpScale(1, 0), 1);
  });
});
