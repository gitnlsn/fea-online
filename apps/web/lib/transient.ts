/**
 * The TypeScript side of the transient Euler wire format.
 *
 * Mirrors `crates/fea-wasm/src/transient.rs`. The tagged shapes below are
 * pinned on the Rust side by `mod wire_format`, because nothing else can check
 * that these two files agree -- a renamed variant would compile on both sides
 * and fail only at run time, inside a worker, as a parse error with no
 * indication of which field was wrong.
 *
 * ## Why a run is pulled rather than returned
 *
 * A steady solve is one call. A transient run is thousands of steps producing
 * sixty fields, so it is driven a frame at a time: the worker holds the Rust
 * object and the main thread asks for frames. That buys progress reporting and
 * cancellation, and keeps peak memory to one frame in Rust rather than all of
 * them.
 */

import { loopEntries } from "./solve.ts";
import type { DrawableField, EdgeKey, LoopKey } from "./solve.ts";
import type { Loop } from "./mesh.ts";

/** A gas state as a person states it: primitive variables. */
export interface GasState {
  density: number;
  velocity: [number, number];
  pressure: number;
}

/**
 * What is on the other side of a boundary.
 *
 * Nothing here looks like the steady path's Dirichlet/Neumann/Robin, because a
 * hyperbolic boundary is not a constraint on the solution. It is a statement
 * about the gas outside, and the numerical flux works out for itself which
 * characteristics carry information in and which carry it out.
 */
export type GasConditionSpec =
  | { kind: "slip_wall" }
  | { kind: "transmissive" }
  | { kind: "inflow"; state: GasState; schedule: InflowSchedule }
  | { kind: "outflow"; pressure: number }
  | { kind: "supersonic_inflow"; state: GasState };

/** How an inflow's state moves with time. Mirrors the Rust enum. */
export type InflowSchedule =
  | { kind: "steady" }
  | { kind: "ramp"; over: number }
  | { kind: "pulse"; start: number; end: number }
  | { kind: "oscillation"; period: number };

export const STEADY: InflowSchedule = { kind: "steady" };

/** What the run starts from. */
export type InitialSpec =
  | { kind: "uniform"; state: GasState }
  | {
      kind: "riemann";
      normal: [number, number];
      position: number;
      left: GasState;
      right: GasState;
    }
  | {
      kind: "blast";
      centre: [number, number];
      radius: number;
      inside: GasState;
      outside: GasState;
    };

/** The scalar drawn. Four conserved variables cannot be shown at once. */
export type DerivedField =
  | "density"
  | "pressure"
  | "energy"
  | "temperature"
  | "speed"
  | "mach";

/**
 * The scalars offered, grouped by what they say.
 *
 * Velocity is deliberately absent: it is a vector, and colouring a domain by
 * one component or by the magnitude alone throws away the direction that is
 * most of its content. It is drawn as arrows instead, over whichever scalar is
 * chosen here.
 */
export const DERIVED_FIELDS: { value: DerivedField; label: string; group: string }[] = [
  { value: "density", label: "Density", group: "State" },
  { value: "pressure", label: "Pressure", group: "State" },
  { value: "energy", label: "Total energy", group: "Energy" },
  { value: "temperature", label: "Internal energy", group: "Energy" },
  { value: "speed", label: "Speed", group: "Motion" },
  { value: "mach", label: "Mach number", group: "Motion" },
];

export interface TransientRequest {
  vertices: number[];
  triangles: number[];
  segments: number[];
  segment_tags: number[];
  conditions: GasConditionSpec[];
  initial: InitialSpec;
  gamma: number;
  degree: number;
  end_time: number;
  frames: number;
  cfl: number;
  limiter: number;
  subdivisions: number;
  field: DerivedField;
}

/** Everything fixed about a run once it starts. */
export interface TransientSetup {
  sub_triangles: number[];
  sample_stride: number;
  subdivisions: number;
  element_count: number;
  mode_count: number;
  degree: number;
  frames: number;
  unclassified_faces: number;
  worst_match_distance: number;
}

export interface TransientProgress {
  frame: number;
  frames: number;
  time: number;
  steps: number;
  smallest_step: number;
  blew_up: boolean;
  hit_step_cap: boolean;
  unrecoverable: number;
}

/** One sampled frame, as it crosses from the worker. */
export interface TransientFrame {
  index: number;
  time: number;
  values: Float32Array;
  /** `[vx, vy]` per element. Its own payload, because it is not a scalar. */
  vectors: Float32Array;
  min: number;
  max: number;
  /** The fastest speed in this frame, which scales the arrows. */
  fastest: number;
}

export type TransientWorkerRequest =
  | { id: number; kind: "start"; request: TransientRequest }
  | { id: number; kind: "cancel" };

export type TransientWorkerResponse =
  | {
      id: number;
      kind: "setup";
      setup: TransientSetup;
      positions: Float32Array;
      vectorOrigins: Float32Array;
    }
  | { id: number; kind: "frame"; frame: TransientFrame; progress: TransientProgress }
  | { id: number; kind: "done"; progress: TransientProgress; elapsedMs: number }
  | { id: number; kind: "error"; error: string };

/**
 * A stable identity for a transient problem.
 *
 * The mesh travels by key rather than by value for the same reason the steady
 * path does it: the vertex and triangle arrays are far too large to serialise
 * on every keystroke, and the mesher already has an identity for them.
 */
export function transientRequestKey(request: TransientRequest, meshKey: string): string {
  const { vertices, triangles, ...rest } = request;
  void vertices;
  void triangles;
  return JSON.stringify({ mesh: meshKey, ...rest });
}

/**
 * Presents one frame to the renderers as a field they can draw.
 *
 * The positions are the run's, shared by every frame and never copied; only
 * `values` differs from one frame to the next. That is the whole reason the
 * worker sends positions once: they are two thirds of a frame's bytes and they
 * are identical every time.
 *
 * The colour range is the run's, not the frame's. A per-frame range would
 * rescale the ramp on every tick, so a shock crossing the domain would look like
 * a field of constant intensity moving through a changing colour scheme rather
 * than like a wave decaying -- which is exactly the thing an animation is for
 * showing.
 */
export function frameField(
  setup: TransientSetup,
  positions: Float32Array,
  frame: TransientFrame,
  range: { min: number; max: number },
): DrawableField {
  return {
    positions,
    values: frame.values,
    sub_triangles: setup.sub_triangles,
    sample_stride: setup.sample_stride,
    subdivisions: setup.subdivisions,
    element_count: setup.element_count,
    min_value: range.min,
    max_value: range.max,
    identity: frame.index,
  };
}

/** The extremes over every frame collected so far. */
export function rangeOver(frames: TransientFrame[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const frame of frames) {
    if (frame.min < min) min = frame.min;
    if (frame.max > max) max = frame.max;
  }
  // A run with no frames, or an entirely flat field, still has to give the ramp
  // something it can divide by.
  if (!(min < max)) return { min: min === Infinity ? 0 : min, max: min === Infinity ? 1 : min + 1 };
  return { min, max };
}

/** The kinds a gas boundary can be, in the words the panel uses. */
export type GasConditionKind = "wall" | "open" | "inflow" | "outflow";

export const GAS_CONDITION_KINDS: {
  kind: GasConditionKind;
  label: string;
  hint: string;
}[] = [
  { kind: "wall", label: "Wall", hint: "reflects" },
  { kind: "open", label: "Open", hint: "extrapolates" },
  { kind: "inflow", label: "Inflow", hint: "gas enters" },
  { kind: "outflow", label: "Outflow", hint: "held at a pressure" },
];

/**
 * A gas condition as the *editor* holds it.
 *
 * Every field is present for every kind, exactly as `ConditionValue` carries a
 * Robin coefficient whatever kind is selected. Without that, switching a row to
 * Wall and back would discard the inflow state the user typed -- and the first
 * version of this panel did precisely that, which is why the inflow state ended
 * up hardcoded with nowhere to live. `toGasSpec` is what drops the unused
 * fields on the way to the solver.
 */
export interface GasConditionValue {
  kind: GasConditionKind;
  /** Inflow only. */
  state: GasState;
  /** Inflow only. */
  schedule: InflowSchedule;
  /** Outflow only: the static pressure held just outside. */
  pressure: number;
}

/** A wall, which is what an unstated boundary is: the gas has to stop somewhere. */
export const DEFAULT_GAS_CONDITION: GasConditionValue = {
  kind: "wall",
  state: { density: 1, velocity: [3, 0], pressure: 1 },
  schedule: STEADY,
  pressure: 1,
};

/** Drops the fields a kind does not use, matching the Rust enum. */
export function toGasSpec(condition: GasConditionValue): GasConditionSpec {
  switch (condition.kind) {
    case "wall":
      return { kind: "slip_wall" };
    case "open":
      return { kind: "transmissive" };
    case "inflow":
      return { kind: "inflow", state: condition.state, schedule: condition.schedule };
    case "outflow":
      return { kind: "outflow", pressure: condition.pressure };
  }
}

/**
 * Gas conditions attached to the drawn geometry.
 *
 * Two levels, for the same reason the steady path has two: a loop-level entry
 * says what a wall *is* and survives its loop being redrawn, while an edge-level
 * entry is an exception pinned to an index that only means anything while the
 * loop keeps its vertex count.
 */
export interface GasConditions {
  loops: Partial<Record<LoopKey, GasConditionValue>>;
  edges: Partial<Record<EdgeKey, GasConditionValue>>;
}

export const NO_GAS_CONDITIONS: GasConditions = { loops: {}, edges: {} };

/** The condition on one edge: its own override, else its loop's. */
export function gasConditionFor(
  conditions: GasConditions,
  loop: LoopKey,
  edge: number,
): GasConditionValue {
  return (
    conditions.edges[`${loop}:${edge}` as EdgeKey] ??
    conditions.loops[loop] ??
    DEFAULT_GAS_CONDITION
  );
}

/**
 * The conditions as they apply to the geometry currently drawn.
 *
 * Asymmetric on purpose, exactly as `reconcileConditions` is: **loop entries are
 * always materialised**, so a loop always resolves to something, while **edge
 * entries survive only if present**, so `conditions.edges[key] !== undefined` is
 * the test for "this edge has an override" that the panel needs.
 */
export function reconcileGasConditions(
  boundary: Loop | null,
  holes: Loop[],
  previous: GasConditions,
): GasConditions {
  const loops: Partial<Record<LoopKey, GasConditionValue>> = {};
  const edges: Partial<Record<EdgeKey, GasConditionValue>> = {};

  for (const { key, loop } of loopEntries(boundary, holes)) {
    loops[key] = previous.loops[key] ?? DEFAULT_GAS_CONDITION;

    for (let edge = 0; edge < loop.length; edge++) {
      const edgeKey = `${key}:${edge}` as EdgeKey;
      const override = previous.edges[edgeKey];
      if (override) edges[edgeKey] = override;
    }
  }

  return { loops, edges };
}

/** Everything the gas study holds, apart from its boundary conditions. */
export interface TransientSettings {
  initial: InitialSpec;
  endTime: number;
  frames: number;
  degree: number;
  cfl: number;
  limiter: number;
  field: DerivedField;
  /** Whether velocity arrows are drawn over the scalar. */
  showVectors: boolean;
}

/**
 * Flattens the drawn loops into the segment list the solver classifies faces
 * against, interning one condition per distinct choice.
 *
 * Per **edge**, not per loop. The segment and tag arrays already had that
 * granularity and the interning already collapses it back down, so an edge-level
 * model costs nothing on the wire when every edge of a loop agrees.
 */
export function buildTransientGeometry(
  boundary: Loop | null,
  holes: Loop[],
  conditions: GasConditions,
): { segments: number[]; segment_tags: number[]; conditions: GasConditionSpec[] } {
  const segments: number[] = [];
  const segment_tags: number[] = [];
  const specs: GasConditionSpec[] = [];
  const seen = new Map<string, number>();

  const intern = (spec: GasConditionSpec): number => {
    const shape = JSON.stringify(spec);
    const existing = seen.get(shape);
    if (existing !== undefined) return existing;
    const tag = specs.length;
    specs.push(spec);
    seen.set(shape, tag);
    return tag;
  };

  // Tag 0 must exist: the solver falls back to it for any face no segment
  // claims, and there is always at least round-off's worth of those.
  intern(toGasSpec(DEFAULT_GAS_CONDITION));

  for (const { key, loop } of loopEntries(boundary, holes)) {
    for (let edge = 0; edge < loop.length; edge++) {
      const from = loop[edge];
      const to = loop[(edge + 1) % loop.length];
      segments.push(from[0], from[1], to[0], to[1]);
      segment_tags.push(intern(toGasSpec(gasConditionFor(conditions, key, edge))));
    }
  }

  return { segments, segment_tags, conditions: specs };
}

/**
 * How each kind is stroked on the drawing.
 *
 * Colour *and* dash, never colour alone. `globals.css` defines exactly one
 * categorical hue and reserves the status colours for cases "only ever shown
 * alongside an explicit count + label", so meaning that rested on hue would be
 * both unavailable and against the grain of the file. The hues below are mid
 * steps of ramps that file has already validated for lightness and for
 * colour-vision separation, rather than new ones needing the same work.
 */
export const GAS_CONDITION_TONES: Record<
  GasConditionKind,
  { token: string; dash: number[]; width: number }
> = {
  wall: { token: "--text-secondary", dash: [], width: 2.5 },
  open: { token: "--series-1", dash: [6, 4], width: 2 },
  outflow: { token: "--seq-300", dash: [12, 4], width: 2.5 },
  inflow: { token: "--field-400", dash: [], width: 3.5 },
};

/** The Mach number of an inflow state, which decides how it is imposed. */
export function machOf(state: GasState, gamma: number = 1.4): number {
  const speed = Math.hypot(state.velocity[0], state.velocity[1]);
  const sound = Math.sqrt((gamma * state.pressure) / state.density);
  return Number.isFinite(sound) && sound > 0 ? speed / sound : 0;
}

/** Air at rest at unit density and pressure: the ambient the presets sit in. */
export const AMBIENT: GasState = { density: 1, velocity: [0, 0], pressure: 1 };

/** A blast, stated as a pressure ratio against the ambient. */
export function blastInitial(
  centre: [number, number],
  radius: number,
  ratio: number,
): InitialSpec {
  return {
    kind: "blast",
    centre,
    radius,
    inside: { density: ratio, velocity: [0, 0], pressure: ratio },
    outside: AMBIENT,
  };
}
