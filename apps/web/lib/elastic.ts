/**
 * The TypeScript side of the linear elastostatics wire format.
 *
 * Mirrors `crates/fea-wasm/src/elastic.rs`. The tagged shapes below are pinned
 * on the Rust side by `mod wire_format`, because nothing else can check that the
 * two files agree -- a renamed variant would compile on both sides and fail only
 * at run time, inside a worker, as a parse error naming no field.
 *
 * ## Why the field is derived here rather than requested
 *
 * A diffusion solve returns one scalar because there is one thing to draw. A
 * solid has a dozen -- displacement and its components, three strains, three
 * stresses, von Mises, the principal stresses, max shear, strain energy -- and
 * asking Rust for whichever one the dropdown names would make changing the
 * dropdown a re-solve.
 *
 * So the response carries displacement and strain, the two fields every other is
 * an algebraic function of, and {@link deriveField} does one pass over them.
 * Switching field is then a render, and the formulae live where they can be
 * unit-tested without a wasm build -- which matters most for von Mises, where the
 * plane state changes the answer and getting it wrong is invisible.
 */

import { loopEntries } from "./solve.ts";
import type { DrawableField, EdgeKey, LoopKey } from "./solve.ts";
import type { Loop } from "./mesh.ts";

/** Which two-dimensional idealisation applies. Mirrors `PlaneStateSpec`. */
export type PlaneState = "strain" | "stress";

export const PLANE_STATES: { value: PlaneState; label: string; hint: string }[] = [
  {
    value: "stress",
    label: "Plane stress",
    hint: "A sheet thin through its thickness: a bracket, a gusset, a panel.",
  },
  {
    value: "strain",
    label: "Plane strain",
    hint: "A slice of something long: a dam, a tunnel lining, a long weld.",
  },
];

/** Mirrors `ElasticConditionSpec` in `crates/fea-wasm/src/elastic.rs`. */
export type ElasticConditionSpec =
  | { kind: "fixed" }
  | { kind: "displacement"; x: number; y: number }
  | { kind: "free" }
  | { kind: "traction"; x: number; y: number }
  | { kind: "force"; x: number; y: number; length: number }
  | { kind: "roller_x" }
  | { kind: "roller_y" }
  | { kind: "spring"; stiffness: number };

export type ElasticConditionKind = ElasticConditionSpec["kind"];

/**
 * A support or load as the UI states it.
 *
 * Every kind's numbers are carried whatever the kind is, so switching a row from
 * a traction to a force and back does not lose what was typed. {@link toElasticSpec}
 * is what drops the unused ones on the way out -- the same split `ConditionValue`
 * makes on the diffusion side.
 *
 * `length` is absent here on purpose: a total force is spread over the edge it
 * is attached to, and that edge's length is a fact about the geometry rather
 * than something the user states. {@link buildElasticGeometry} measures it.
 */
export interface ElasticConditionValue {
  kind: ElasticConditionKind;
  /** Displacement, traction, or total force, depending on `kind`. */
  x: number;
  y: number;
  /** Spring only: the foundation stiffness. Must be positive. */
  stiffness: number;
}

export const DEFAULT_ELASTIC_CONDITION: ElasticConditionValue = {
  kind: "free",
  x: 0,
  y: 0,
  stiffness: 1,
};

export const ELASTIC_CONDITION_KINDS: {
  value: ElasticConditionKind;
  label: string;
  hint: string;
  group: "Support" | "Load";
}[] = [
  { value: "free", label: "Free", hint: "Nothing holds it and nothing pushes on it.", group: "Load" },
  { value: "fixed", label: "Fixed", hint: "Clamped: neither component can move.", group: "Support" },
  {
    value: "displacement",
    label: "Prescribed move",
    hint: "The edge is moved to a stated displacement.",
    group: "Support",
  },
  {
    value: "roller_x",
    label: "Roller (vertical edge)",
    hint: "Holds sideways motion, free to slide up and down.",
    group: "Support",
  },
  {
    value: "roller_y",
    label: "Roller (horizontal edge)",
    hint: "Holds vertical motion, free to slide sideways.",
    group: "Support",
  },
  {
    value: "spring",
    label: "Elastic foundation",
    hint: "Resists motion in proportion to it, rather than forbidding it.",
    group: "Support",
  },
  {
    value: "traction",
    label: "Pressure",
    hint: "A load per unit length, spread evenly along the edge.",
    group: "Load",
  },
  {
    value: "force",
    label: "Force (total)",
    hint: "A total force, spread over the edge it is on. Draw a short edge to concentrate it.",
    group: "Load",
  },
];

/** Whether a kind constrains displacement at all. */
export function holdsDisplacement(kind: ElasticConditionKind): boolean {
  return kind !== "free" && kind !== "traction" && kind !== "force";
}

/**
 * How each kind is stroked on the canvas.
 *
 * Supports are solid and loads are dashed, so the two read apart at a glance
 * without the legend -- which is the distinction that matters when looking at a
 * part and asking why it is not held.
 */
export const ELASTIC_CONDITION_TONES: Record<
  ElasticConditionKind,
  { token: string; dash: number[]; width: number }
> = {
  free: { token: "--border", dash: [], width: 1.5 },
  fixed: { token: "--text-secondary", dash: [], width: 3.5 },
  displacement: { token: "--series-1", dash: [], width: 3 },
  roller_x: { token: "--text-secondary", dash: [2, 3], width: 2.5 },
  roller_y: { token: "--text-secondary", dash: [2, 3], width: 2.5 },
  spring: { token: "--seq-300", dash: [1, 3], width: 2.5 },
  traction: { token: "--field-400", dash: [8, 4], width: 3 },
  force: { token: "--field-400", dash: [12, 3, 3, 3], width: 3.5 },
};

export interface ElasticRequest {
  vertices: number[];
  triangles: number[];
  segments: number[];
  segment_tags: number[];
  conditions: ElasticConditionSpec[];
  youngs_modulus: number;
  poisson_ratio: number;
  plane: PlaneState;
  body_force: [number, number];
  degree: number;
  tolerance: number;
  max_iterations: number;
  subdivisions: number;
}

/** Mirrors `ElasticResponse`. Not a `DrawableField` -- it carries no scalar. */
export interface ElasticResponse {
  positions: number[];
  /** Interleaved [ux, uy] per sample point, sharing `positions`' indexing. */
  displacements: number[];
  /** [eps_xx, eps_yy, eps_xy] per sample point, with the tensor shear. */
  strains: number[];
  sub_triangles: number[];
  sample_stride: number;
  subdivisions: number;

  element_count: number;
  mode_count: number;
  degree: number;

  /** Effective first Lame parameter, already carrying the plane-stress swap. */
  lambda: number;
  mu: number;
  poisson_ratio: number;
  plane: PlaneState;

  largest_displacement: number;
  /** Bounding-box diagonal of the part, which the warp scale is relative to. */
  extent: number;

  iterations: number;
  residual_norm: number;
  initial_norm: number;
  converged: boolean;

  unclassified_faces: number;
  worst_match_distance: number;
}

export type ElasticWorkerRequest = { id: number; request: ElasticRequest };

export type ElasticWorkerResponse =
  | { id: number; ok: true; result: ElasticResponse; elapsedMs: number }
  | { id: number; ok: false; error: string };

// ---------------------------------------------------------------------------
// Conditions attached to the drawn geometry
// ---------------------------------------------------------------------------

export interface ElasticConditions {
  loops: Partial<Record<LoopKey, ElasticConditionValue>>;
  edges: Partial<Record<EdgeKey, ElasticConditionValue>>;
}

export const NO_ELASTIC_CONDITIONS: ElasticConditions = { loops: {}, edges: {} };

/** The condition on one edge: its own override, else its loop's. */
export function elasticConditionFor(
  conditions: ElasticConditions,
  loop: LoopKey,
  edge: number,
): ElasticConditionValue {
  return (
    conditions.edges[`${loop}:${edge}` as EdgeKey] ??
    conditions.loops[loop] ??
    DEFAULT_ELASTIC_CONDITION
  );
}

/**
 * Reconciles a condition record against the loops currently drawn.
 *
 * Same rule as the diffusion and gas paths: a loop-level condition survives its
 * loop being redrawn, an edge-level override does not survive the edge index
 * going out of range.
 */
export function reconcileElasticConditions(
  boundary: Loop | null,
  holes: Loop[],
  previous: ElasticConditions,
): ElasticConditions {
  const loops: Partial<Record<LoopKey, ElasticConditionValue>> = {};
  const edges: Partial<Record<EdgeKey, ElasticConditionValue>> = {};

  for (const { key, loop } of loopEntries(boundary, holes)) {
    loops[key] = previous.loops[key] ?? DEFAULT_ELASTIC_CONDITION;

    for (let edge = 0; edge < loop.length; edge++) {
      const edgeKey = `${key}:${edge}` as EdgeKey;
      const override = previous.edges[edgeKey];
      if (override) edges[edgeKey] = override;
    }
  }

  return { loops, edges };
}

/**
 * Drops the fields a given kind does not use, matching the Rust enum.
 *
 * `length` comes from the geometry rather than from the condition, so a total
 * force needs the edge it sits on to be measured before it can be stated.
 */
export function toElasticSpec(
  condition: ElasticConditionValue,
  edgeLength: number,
): ElasticConditionSpec {
  switch (condition.kind) {
    case "fixed":
      return { kind: "fixed" };
    case "displacement":
      return { kind: "displacement", x: condition.x, y: condition.y };
    case "free":
      return { kind: "free" };
    case "traction":
      return { kind: "traction", x: condition.x, y: condition.y };
    case "force":
      return { kind: "force", x: condition.x, y: condition.y, length: edgeLength };
    case "roller_x":
      return { kind: "roller_x" };
    case "roller_y":
      return { kind: "roller_y" };
    case "spring":
      return { kind: "spring", stiffness: condition.stiffness };
  }
}

/**
 * Flattens the drawn loops and their conditions into the request's tables.
 *
 * Conditions are interned by their serialised form, exactly as on the diffusion
 * side. One consequence is worth stating because it is surprising: two edges
 * carrying the *same* total force but of different lengths intern to different
 * tags, because the length is part of the spec. That is correct -- they apply
 * different tractions -- and it is why the length is measured per edge here
 * rather than stored on the condition.
 */
export function buildElasticGeometry(
  boundary: Loop | null,
  holes: Loop[],
  conditions: ElasticConditions,
): {
  segments: number[];
  segment_tags: number[];
  conditions: ElasticConditionSpec[];
} {
  const segments: number[] = [];
  const segment_tags: number[] = [];
  const specs: ElasticConditionSpec[] = [];
  const seen = new Map<string, number>();

  const intern = (spec: ElasticConditionSpec): number => {
    const shape = JSON.stringify(spec);
    const existing = seen.get(shape);
    if (existing !== undefined) return existing;
    const tag = specs.length;
    specs.push(spec);
    seen.set(shape, tag);
    return tag;
  };

  for (const { key, loop } of loopEntries(boundary, holes)) {
    for (let edge = 0; edge < loop.length; edge++) {
      const [ax, ay] = loop[edge];
      // The closing edge is implicit in a `Loop`, so the last edge wraps.
      const [bx, by] = loop[(edge + 1) % loop.length];
      segments.push(ax, ay, bx, by);
      const length = Math.hypot(bx - ax, by - ay);
      segment_tags.push(
        intern(toElasticSpec(elasticConditionFor(conditions, key, edge), length)),
      );
    }
  }

  // The solver falls back to tag 0 for any face no segment claims, so tag 0 has
  // to exist even when there is nothing to intern.
  if (specs.length === 0) specs.push({ kind: "free" });

  return { segments, segment_tags, conditions: specs };
}

/** Stable identity for an elastic solve: same problem, same key. */
export function elasticRequestKey(request: ElasticRequest, meshKey: string): string {
  return JSON.stringify([
    meshKey,
    request.segments,
    request.segment_tags,
    request.conditions,
    request.youngs_modulus,
    request.poisson_ratio,
    request.plane,
    request.body_force,
    request.degree,
    request.tolerance,
    request.max_iterations,
    request.subdivisions,
  ]);
}

// ---------------------------------------------------------------------------
// Derived fields
// ---------------------------------------------------------------------------

export type ElasticField =
  | "magnitude"
  | "ux"
  | "uy"
  | "exx"
  | "eyy"
  | "exy"
  | "sxx"
  | "syy"
  | "sxy"
  | "von_mises"
  | "principal_max"
  | "principal_min"
  | "max_shear"
  | "energy";

export const ELASTIC_FIELDS: {
  value: ElasticField;
  label: string;
  group: string;
}[] = [
  { value: "magnitude", label: "Displacement", group: "Motion" },
  { value: "ux", label: "Displacement x", group: "Motion" },
  { value: "uy", label: "Displacement y", group: "Motion" },
  { value: "von_mises", label: "von Mises stress", group: "Stress" },
  { value: "principal_max", label: "Principal stress σ₁", group: "Stress" },
  { value: "principal_min", label: "Principal stress σ₂", group: "Stress" },
  { value: "max_shear", label: "Max shear stress", group: "Stress" },
  { value: "sxx", label: "Stress σxx", group: "Stress components" },
  { value: "syy", label: "Stress σyy", group: "Stress components" },
  { value: "sxy", label: "Stress σxy", group: "Stress components" },
  { value: "exx", label: "Strain εxx", group: "Strain" },
  { value: "eyy", label: "Strain εyy", group: "Strain" },
  { value: "exy", label: "Strain εxy", group: "Strain" },
  { value: "energy", label: "Strain energy density", group: "Strain" },
];

/** The stress the material carries at a strain, given the plane state. */
export interface StressState {
  xx: number;
  yy: number;
  xy: number;
  /**
   * The out-of-plane component, which the two idealisations disagree about.
   *
   * Plane stress has it identically zero. Plane strain has `nu (sxx + syy)`,
   * which at `nu = 0.3` shifts the von Mises stress modestly and near
   * incompressibility dominates it -- so a three-dimensional invariant computed
   * from the two in-plane components alone silently assumes plane stress.
   */
  zz: number;
}

export function stressAt(
  response: Pick<ElasticResponse, "lambda" | "mu" | "poisson_ratio" | "plane">,
  exx: number,
  eyy: number,
  exy: number,
): StressState {
  const dilatation = response.lambda * (exx + eyy);
  const xx = dilatation + 2 * response.mu * exx;
  const yy = dilatation + 2 * response.mu * eyy;
  // eps_xy is the tensor shear, so sigma_xy = 2 mu eps_xy = mu gamma_xy.
  const xy = 2 * response.mu * exy;
  const zz = response.plane === "stress" ? 0 : response.poisson_ratio * (xx + yy);
  return { xx, yy, xy, zz };
}

/** The in-plane principal stresses, larger first, and the max in-plane shear. */
export function principalStresses(stress: StressState): {
  major: number;
  minor: number;
  shear: number;
} {
  const mean = (stress.xx + stress.yy) / 2;
  const shear = Math.hypot((stress.xx - stress.yy) / 2, stress.xy);
  return { major: mean + shear, minor: mean - shear, shear };
}

/**
 * The three-dimensional von Mises stress.
 *
 * Written with all three normal components rather than as the plane-stress
 * shortcut `sqrt(sxx^2 - sxx syy + syy^2 + 3 sxy^2)`, so that plane strain gets
 * the answer it is owed. The shortcut is the plane-strain formula's special case
 * at `szz = 0`, and using it everywhere would understate a plane-strain result
 * by a factor that grows with Poisson's ratio.
 */
export function vonMises(stress: StressState): number {
  const { xx, yy, zz, xy } = stress;
  return Math.sqrt(
    ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) / 2 + 3 * xy * xy,
  );
}

/**
 * Turns a solved part into something the viewports can draw.
 *
 * One pass, so switching field is a render rather than a solve. The
 * `displacements` array rides along on the result: it is what the renderers warp
 * by, and it is the same for every field, so it is attached once here rather
 * than threaded separately through every call site.
 */
export function deriveField(
  response: ElasticResponse,
  field: ElasticField,
): DrawableField {
  const samples = response.element_count * response.sample_stride;
  const values = new Float32Array(samples);
  let min = Infinity;
  let max = -Infinity;

  for (let index = 0; index < samples; index++) {
    let value: number;

    switch (field) {
      case "magnitude":
        value = Math.hypot(
          response.displacements[index * 2],
          response.displacements[index * 2 + 1],
        );
        break;
      case "ux":
        value = response.displacements[index * 2];
        break;
      case "uy":
        value = response.displacements[index * 2 + 1];
        break;
      case "exx":
        value = response.strains[index * 3];
        break;
      case "eyy":
        value = response.strains[index * 3 + 1];
        break;
      case "exy":
        value = response.strains[index * 3 + 2];
        break;
      default: {
        const exx = response.strains[index * 3];
        const eyy = response.strains[index * 3 + 1];
        const exy = response.strains[index * 3 + 2];
        const stress = stressAt(response, exx, eyy, exy);

        switch (field) {
          case "sxx":
            value = stress.xx;
            break;
          case "syy":
            value = stress.yy;
            break;
          case "sxy":
            value = stress.xy;
            break;
          case "von_mises":
            value = vonMises(stress);
            break;
          case "principal_max":
            value = principalStresses(stress).major;
            break;
          case "principal_min":
            value = principalStresses(stress).minor;
            break;
          case "max_shear":
            value = principalStresses(stress).shear;
            break;
          case "energy":
            // (sigma : eps) / 2, with the shear counted twice as the double
            // contraction of a symmetric pair requires.
            value = (stress.xx * exx + stress.yy * eyy + 2 * stress.xy * exy) / 2;
            break;
          default:
            value = 0;
        }
      }
    }

    values[index] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }

  return {
    positions: response.positions,
    values,
    displacements: response.displacements,
    sub_triangles: response.sub_triangles,
    sample_stride: response.sample_stride,
    subdivisions: response.subdivisions,
    element_count: response.element_count,
    min_value: min,
    max_value: max,
  };
}

/**
 * An exaggeration factor that opens the deformation to a readable size.
 *
 * The same argument `autoZScale` makes about surface height: a steel bracket
 * under a realistic load moves by microns, and drawing that to scale draws
 * nothing at all. A twentieth of the part's diagonal is large enough to read and
 * small enough that the shape is still recognisable.
 *
 * Rounded to one significant figure so the number beside the slider is one a
 * person would have chosen -- "×2000", not "×1873.4".
 */
export function autoWarpScale(largest: number, extent: number): number {
  if (!(largest > 0) || !(extent > 0)) return 1;
  const wanted = (extent * 0.05) / largest;
  if (!Number.isFinite(wanted) || wanted <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(wanted));
  return Math.max(magnitude * Math.round(wanted / magnitude), magnitude);
}
