/**
 * Colour for the solution field.
 *
 * Mirrors the `--field-*` and `--div-*` tokens in `globals.css`, which is where
 * the derivation is documented. Kept as a module rather than read back out of
 * the stylesheet because the canvas and the legend must agree exactly -- a
 * legend that disagrees with the picture by one step is worse than no legend --
 * and because the field is rasterised into an offscreen buffer where a
 * `getComputedStyle` call per element would be the dominant cost.
 */

/** Sequential orange, low to high. */
export const FIELD_RAMP: readonly string[] = [
  "#fbd7ca",
  "#f2b098",
  "#e68764",
  "#d95923",
  "#b44005",
  "#8a2e00",
  "#621e00",
];

/**
 * Cool arm of the diverging ramp, running away from the midpoint.
 *
 * Exported for the 3D view, which cannot call `fieldColor` -- it steps the ramp
 * per fragment on the GPU and so needs the stops themselves, uploaded once as a
 * uniform. Sharing the array rather than transcribing it into GLSL is what keeps
 * the two views, and the legend, from drifting apart.
 */
export const DIVERGING_COOL: readonly string[] = [
  "#9ec5f4",
  "#6da7ec",
  "#3987e5",
  "#256abf",
  "#184f95",
  "#0d366b",
];

/** Warm arm of the diverging ramp, running away from the midpoint. See above. */
export const DIVERGING_WARM: readonly string[] = [
  "#f7aba4",
  "#ec7f78",
  "#e04c4a",
  "#ba3333",
  "#902123",
  "#671315",
];

export type FieldScale =
  | { kind: "sequential"; min: number; max: number }
  | { kind: "diverging"; min: number; max: number; extent: number };

/**
 * How far inside the range zero has to sit before it is worth diverging about.
 *
 * Not a tolerance -- a judgement about when sign is the story. A discontinuous
 * Galerkin solution routinely overshoots its own boundary data by a few percent
 * near a steep gradient, so a plate held between 0 and 100 comes back spanning
 * roughly -3 to 102. That field has no negative *region*; it has a numerical
 * fringe. Diverging about zero there spends the entire neutral half of the ramp
 * on 3% of the data and washes the other 97% into one arm, which reads as a
 * mostly-empty domain. Below this fraction the minority side is treated as an
 * endpoint, which is what it is.
 */
const DIVERGING_THRESHOLD = 0.15;

/**
 * How a field's range should be coloured.
 *
 * A field with a real negative region has a *sign*, and sign is the first thing
 * a reader looks for -- so it gets the diverging ramp, where the midpoint is a
 * neutral and the two arms are opposite hues. A field that is essentially
 * one-signed has no sign to show, only magnitude, so it gets the one-hue
 * sequential ramp. Choosing from the data rather than from a setting keeps the
 * encoding matched to the question the field can actually answer, and the legend
 * states the midpoint numerically so the choice is never something the reader
 * has to infer.
 *
 * The diverging arms are scaled to the larger side, not each to its own, so
 * equal distances from zero take equal colour. Scaling each arm independently
 * would make a field running -1 to +100 look symmetric.
 */
export function fieldScale(min: number, max: number): FieldScale {
  const span = max - min;
  // Where zero falls along the range. Diverging is worth it only when zero is
  // genuinely interior; at either extreme it is indistinguishable from an end.
  const zeroAt = span > 0 ? (0 - min) / span : 0;

  if (
    min < 0 &&
    max > 0 &&
    zeroAt >= DIVERGING_THRESHOLD &&
    zeroAt <= 1 - DIVERGING_THRESHOLD
  ) {
    return { kind: "diverging", min, max, extent: Math.max(-min, max) };
  }
  return { kind: "sequential", min, max };
}

/** The value the middle of the ramp stands for. */
export function scaleMidpoint(scale: FieldScale): number {
  return scale.kind === "diverging" ? 0 : (scale.min + scale.max) / 2;
}

function step(ramp: readonly string[], fraction: number): string {
  const index = Math.floor(fraction * ramp.length);
  return ramp[Math.min(ramp.length - 1, Math.max(0, index))];
}

/**
 * The colour a value takes under a scale.
 *
 * `neutral` is the diverging midpoint, passed in rather than read from here
 * because it is the one part of the encoding that does change between light and
 * dark -- and because a canvas `fillStyle` cannot resolve a CSS variable, so
 * somebody has to hand over a real colour. Callers drawing to a canvas resolve
 * `--div-mid` once per pass; callers writing CSS pass `"var(--div-mid)"`.
 */
export function fieldColor(value: number, scale: FieldScale, neutral: string): string {
  if (scale.kind === "diverging") {
    // A field that came out exactly flat has no extent to normalise against.
    // Every value is then the midpoint, which is the honest answer rather than
    // a division by zero.
    if (scale.extent <= 0) return neutral;
    const magnitude = Math.min(1, Math.abs(value) / scale.extent);
    const arm = value < 0 ? [neutral, ...DIVERGING_COOL] : [neutral, ...DIVERGING_WARM];
    return step(arm, magnitude);
  }

  const span = scale.max - scale.min;
  if (span <= 0) return FIELD_RAMP[Math.floor(FIELD_RAMP.length / 2)];
  return step(FIELD_RAMP, (value - scale.min) / span);
}

/**
 * Legend bar colours, low to high.
 *
 * Discrete rather than a smooth blend, so the bar shows the same steps the
 * canvas fills with. A smooth legend over a stepped picture invites the reader
 * to interpolate a value the ramp cannot express.
 */
export function rampStops(scale: FieldScale, neutral: string): string[] {
  if (scale.kind === "diverging") {
    return [...DIVERGING_COOL].reverse().concat(neutral, ...DIVERGING_WARM);
  }
  return [...FIELD_RAMP];
}

/**
 * A `#rrggbb` colour as three floats in 0..1, which is the only form a GLSL
 * uniform will take.
 *
 * Shorthand `#rgb` is not accepted: every colour this is asked to convert comes
 * either from the ramps above or from a `--token` in `globals.css`, and all of
 * those are written in full. Silently mis-parsing the one that was not is worse
 * than returning black.
 */
export function rgbTriplet(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.trim().replace(/^#/, ""), 16);
  if (!Number.isFinite(value) || hex.trim().replace(/^#/, "").length !== 6) {
    return [0, 0, 0];
  }

  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}
