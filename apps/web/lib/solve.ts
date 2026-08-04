import type { Loop } from "./mesh.ts";

/**
 * Which loop a boundary condition belongs to.
 *
 * Holes are keyed by position rather than identity because that is all the
 * geometry model has -- `holes` is a plain array and a hole has no id.
 */
export type LoopKey = "boundary" | `hole:${number}`;

/** A single edge of a loop, identified by the loop and the edge's index in it. */
export type EdgeKey = `${LoopKey}:${number}`;

export type ConditionKind = "dirichlet" | "neumann" | "robin";

/**
 * A boundary condition as the UI states it.
 *
 * Mirrors `ConditionSpec` in `crates/fea-wasm/src/solve.rs`, except that the
 * coefficient is carried for every kind rather than only for Robin. Keeping it
 * means switching a row to Robin and back does not lose the number the user
 * typed; `toSpec` is what drops it on the way out.
 */
export interface ConditionValue {
  kind: ConditionKind;
  value: number;
  /** Robin only: the `c` in `k du/dn + c u = g`. Must be positive. */
  coefficient: number;
}

export const DEFAULT_CONDITION: ConditionValue = {
  kind: "dirichlet",
  value: 0,
  coefficient: 1,
};

/**
 * Conditions attached to the drawn geometry.
 *
 * Two levels, because the two answer different questions. A loop-level entry
 * says what the wall *is* -- "the outer boundary is held at zero" -- and
 * survives the loop being redrawn. An edge-level entry is an exception to that,
 * pinned to a specific edge index, and an index only means anything while the
 * loop keeps its vertex count.
 */
export interface BoundaryConditions {
  loops: Partial<Record<LoopKey, ConditionValue>>;
  edges: Partial<Record<EdgeKey, ConditionValue>>;
}

export const NO_CONDITIONS: BoundaryConditions = { loops: {}, edges: {} };

/** Mirrors `ConditionSpec` in `crates/fea-wasm/src/solve.rs`. */
export type ConditionSpec =
  | { kind: "dirichlet"; value: number }
  | { kind: "neumann"; value: number }
  | { kind: "robin"; coefficient: number; value: number };

/** Mirrors `SourceSpec` in `crates/fea-wasm/src/solve.rs`. */
export type SourceSpec = { kind: "constant"; value: number };

export interface SolveRequest {
  vertices: number[];
  triangles: number[];
  segments: number[];
  segment_tags: number[];
  conditions: ConditionSpec[];
  conductivity: number;
  source: SourceSpec;
  degree: number;
  tolerance: number;
  max_iterations: number;
  subdivisions: number;
}

/**
 * Everything the two viewports need in order to draw a field, and nothing else.
 *
 * Split out from `SolveResponse` because a transient frame is drawable but is
 * not a solve: it has no iteration count, no residual, and nothing to say about
 * whether a linear system converged. Both renderers take this, so a frame of an
 * animation and the answer to a steady solve go down exactly the same path --
 * which is the only way the two views are guaranteed to agree about what a
 * field looks like.
 *
 * The arrays are `ArrayLike` rather than `number[]` because a transient frame
 * arrives from Rust as a `Float32Array`, transferred rather than copied.
 */
export interface DrawableField {
  /** Interleaved [x, y] per sample point, element-major. */
  positions: ArrayLike<number>;
  /** The field at each sample point. */
  values: ArrayLike<number>;
  /** Sub-triangle corners as local lattice indices, shared by every element. */
  sub_triangles: ArrayLike<number>;
  /** Sample points per element. */
  sample_stride: number;
  subdivisions: number;
  element_count: number;

  min_value: number;
  max_value: number;

  /**
   * Distinguishes one field from another when nothing else about it does.
   *
   * The plan view rasterises the field into an offscreen canvas and reuses it
   * until something changes, and decides what "changes" means from the field's
   * dimensions and colour range. For a steady solve that is enough. For a frame
   * of an animation it is not: every frame of a run has the same element count,
   * the same lattice and -- deliberately, so the ramp does not rescale under the
   * viewer -- the same colour range. Without something that varies, the cache
   * would serve frame zero for the whole run.
   *
   * Absent on a steady solution, where the existing key already separates one
   * solve from the next.
   */
  identity?: string | number;

  /**
   * The displacement at each sample point, interleaved [dx, dy] and sharing
   * `positions`' indexing exactly.
   *
   * Undeformed positions plus a separate displacement, rather than deformed
   * positions, so that the exaggeration slider is a uniform update rather than a
   * buffer rebuild -- the same reasoning `uZScale` rests on. Absent for every
   * study whose field is not a displacement, and a renderer that finds it absent
   * draws the plan exactly as it always did.
   */
  displacements?: ArrayLike<number>;
}

export interface SolveResponse extends DrawableField {
  positions: number[];
  values: number[];
  sub_triangles: number[];

  mode_count: number;
  degree: number;

  iterations: number;
  residual_norm: number;
  initial_norm: number;
  /**
   * False when the iteration hit its cap. The field is still returned -- it is
   * the best iterate the solver reached -- and nothing else about it looks
   * different, which is why this has to be shown rather than logged.
   */
  converged: boolean;

  /**
   * The problem fixes the field only up to an additive constant, which happens
   * when nothing anywhere prescribes a value. The level drawn is arbitrary.
   */
  singular: boolean;
  /** Boundary faces no drawn edge claimed; they fell back to the first condition. */
  unclassified_faces: number;
  /** Worst accepted face-to-edge distance, relative to the mesh diameter. */
  worst_match_distance: number;
}

export type SolverWorkerRequest = { id: number; request: SolveRequest };

export type SolverWorkerResponse =
  | { id: number; ok: true; result: SolveResponse; elapsedMs: number }
  | { id: number; ok: false; error: string };

/**
 * Stable identity for a solve: same problem, same key.
 *
 * Mirrors `meshRequestKey`, with two deliberate differences.
 *
 * The mesh is folded in by *key* rather than by value. The vertex and triangle
 * arrays run to megabytes and hashing them on every render would cost more than
 * the comparison saves, while the mesh key already identifies them exactly --
 * it is what produced them.
 *
 * `tolerance` and `max_iterations` are included, where `meshRequestKey`
 * deliberately excludes its equivalents. For the mesher those bound how hard it
 * tries at a fixed target; here they change the field that ends up on screen.
 */
export function solveRequestKey(request: SolveRequest, meshKey: string): string {
  return JSON.stringify([
    meshKey,
    request.segments,
    request.segment_tags,
    request.conditions,
    request.conductivity,
    request.source,
    request.degree,
    request.tolerance,
    request.max_iterations,
    request.subdivisions,
  ]);
}

/** The condition on one edge: its own override, else its loop's. */
export function conditionFor(
  conditions: BoundaryConditions,
  loop: LoopKey,
  edge: number,
): ConditionValue {
  return (
    conditions.edges[`${loop}:${edge}` as EdgeKey] ??
    conditions.loops[loop] ??
    DEFAULT_CONDITION
  );
}

/** Drops the fields a given kind does not use, matching the Rust enum. */
export function toSpec(condition: ConditionValue): ConditionSpec {
  switch (condition.kind) {
    case "dirichlet":
      return { kind: "dirichlet", value: condition.value };
    case "neumann":
      return { kind: "neumann", value: condition.value };
    case "robin":
      return {
        kind: "robin",
        coefficient: condition.coefficient,
        value: condition.value,
      };
  }
}

/** Every loop currently drawn, in the order their edges are sent. */
export function loopEntries(
  boundary: Loop | null,
  holes: Loop[],
): { key: LoopKey; loop: Loop }[] {
  const entries: { key: LoopKey; loop: Loop }[] = [];
  if (boundary) entries.push({ key: "boundary", loop: boundary });
  holes.forEach((hole, index) => {
    entries.push({ key: `hole:${index}`, loop: hole });
  });
  return entries;
}

/**
 * Reconciles a condition record against the loops currently drawn.
 *
 * Conditions outlive individual edits, so they need a rule for what an edit
 * invalidates. The rule is that a loop-level condition survives its loop being
 * redrawn and an edge-level one does not: "the outer wall is held at zero" is a
 * statement about the problem, while "this third edge is different" is a
 * statement about vertices that no longer exist. Applying that consistently in
 * one pure function is what keeps it from being re-derived, differently, in
 * every handler that touches geometry.
 */
export function reconcileConditions(
  boundary: Loop | null,
  holes: Loop[],
  previous: BoundaryConditions,
): BoundaryConditions {
  const entries = loopEntries(boundary, holes);
  const loops: Partial<Record<LoopKey, ConditionValue>> = {};
  const edges: Partial<Record<EdgeKey, ConditionValue>> = {};

  for (const { key, loop } of entries) {
    loops[key] = previous.loops[key] ?? DEFAULT_CONDITION;

    for (let edge = 0; edge < loop.length; edge++) {
      const edgeKey = `${key}:${edge}` as EdgeKey;
      const override = previous.edges[edgeKey];
      if (override) edges[edgeKey] = override;
    }
  }

  // An override on an edge index the loop no longer has is dropped by never
  // being copied above. A loop that shrank therefore loses the overrides past
  // its new end, and keeps the ones still in range -- which is the best that
  // can be said without tracking vertex identity, and is at least never wrong
  // about which edge an override names.
  return { loops, edges };
}

/**
 * Flattens the drawn loops and their conditions into the request's tables.
 *
 * Conditions are interned by their serialised form, so four sides held at the
 * same value share one tag rather than four identical entries. That is what the
 * tag indirection is for: the solver looks each face's tag up in this table, and
 * a table with one entry per edge would make every lookup a distinct branch for
 * no reason.
 */
export function buildSolveGeometry(
  boundary: Loop,
  holes: Loop[],
  conditions: BoundaryConditions,
): { segments: number[]; segment_tags: number[]; conditions: ConditionSpec[] } {
  const segments: number[] = [];
  const segment_tags: number[] = [];
  const specs: ConditionSpec[] = [];
  const tagByShape = new Map<string, number>();

  const intern = (spec: ConditionSpec): number => {
    const shape = JSON.stringify(spec);
    const existing = tagByShape.get(shape);
    if (existing !== undefined) return existing;

    const tag = specs.length;
    specs.push(spec);
    tagByShape.set(shape, tag);
    return tag;
  };

  for (const { key, loop } of loopEntries(boundary, holes)) {
    for (let edge = 0; edge < loop.length; edge++) {
      const [ax, ay] = loop[edge];
      // The closing edge is implicit in a `Loop`, so the last edge wraps.
      const [bx, by] = loop[(edge + 1) % loop.length];
      segments.push(ax, ay, bx, by);
      segment_tags.push(intern(toSpec(conditionFor(conditions, key, edge))));
    }
  }

  // The solver falls back to tag 0 for any face no segment claims, so tag 0 has
  // to exist even when there is nothing to intern.
  if (specs.length === 0) specs.push(toSpec(DEFAULT_CONDITION));

  return { segments, segment_tags, conditions: specs };
}

/**
 * Display lattice order for a given polynomial degree.
 *
 * One sub-triangle per element is exactly right for a linear basis and throws
 * away most of a cubic one, so the resolution follows the degree rather than
 * being a separate control the user has to understand.
 */
export function subdivisionsFor(degree: number): number {
  return Math.min(4, Math.max(1, degree));
}
