import type { Point } from "./mesh.ts";

/** World extent shown in the viewport. Geometry is authored inside this box. */
export const WORLD_SIZE = 100;

/** Clicks quantise to this world-unit increment. */
export const SNAP_STEP = 1;

/** Spacing of the labelled grid lines, in world units. */
export const MAJOR_STEP = 10;

/** Spacing of the unlabelled grid lines, in world units. */
export const MINOR_STEP = 5;

/**
 * Screen-pixel band within which a segment locks to its axis.
 *
 * Expressed in pixels rather than world units so the lock feels the same
 * regardless of how large the viewport is: it is a statement about how
 * precisely a hand can hold a mouse, not about the geometry.
 */
const ORTHO_PX = 8;

/** Gutter reserved on the left and bottom edges for tick labels, in CSS pixels. */
export const RULER_GUTTER = 28;

/** Breathing room on the top and right edges, in CSS pixels. */
export const EDGE_PAD = 14;

export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Fit the world box into the canvas, leaving a gutter for the rulers.
 *
 * The insets are asymmetric because the tick labels only sit on two edges, and
 * centring the world box inside the remaining content area rather than inside
 * the whole canvas is what keeps the drawing off the numbers.
 */
export function computeTransform(width: number, height: number): Transform {
  const contentWidth = width - RULER_GUTTER - EDGE_PAD;
  const contentHeight = height - RULER_GUTTER - EDGE_PAD;
  const scale = Math.min(contentWidth / WORLD_SIZE, contentHeight / WORLD_SIZE);
  const drawn = WORLD_SIZE * scale;

  return {
    scale,
    offsetX: RULER_GUTTER + (contentWidth - drawn) / 2,
    // Flipped so y increases upward, as geometry conventionally does. This is
    // the screen y of world y=0, not a top-left origin.
    offsetY: height - RULER_GUTTER - (contentHeight - drawn) / 2,
  };
}

export function toScreen(point: Point, t: Transform): [number, number] {
  return [point[0] * t.scale + t.offsetX, t.offsetY - point[1] * t.scale];
}

export function toWorld(x: number, y: number, t: Transform): Point {
  return [(x - t.offsetX) / t.scale, (t.offsetY - y) / t.scale];
}

export interface SnapResult {
  point: Point;
  /**
   * Axis held fixed against the anchor, meaning the segment runs along it:
   * "x" is a horizontal segment (shared y), "y" is a vertical one (shared x).
   */
  ortho: "x" | "y" | null;
}

/**
 * Where a click actually lands: quantised to the grid, then optionally locked
 * onto an axis through the previous point.
 *
 * The ortho override writes the anchor's *exact* coordinate rather than a grid
 * value. That is the whole point of having it alongside the grid snap -- it
 * makes an edge exactly axis-aligned even when the anchor came from a loaded
 * `.json` and does not sit on the grid, which grid snapping alone cannot do.
 */
export function snapPoint(
  raw: Point,
  anchor: Point | null,
  scale: number,
  enabled: boolean,
): SnapResult {
  if (!enabled) return { point: raw, ortho: null };

  const quantise = (value: number) => Math.round(value / SNAP_STEP) * SNAP_STEP;
  const point: Point = [quantise(raw[0]), quantise(raw[1])];

  if (!anchor) return { point, ortho: null };

  // Judged against the raw position, not the quantised one: quantising first
  // would make the lock engage or release in whole grid steps.
  const dx = Math.abs(raw[0] - anchor[0]) * scale;
  const dy = Math.abs(raw[1] - anchor[1]) * scale;

  // Near the anchor both offsets are small, so the nearer axis wins rather than
  // x always shadowing y.
  if (dy <= ORTHO_PX && dy <= dx) {
    return { point: [point[0], anchor[1]], ortho: "x" };
  }
  if (dx <= ORTHO_PX) {
    return { point: [anchor[0], point[1]], ortho: "y" };
  }

  return { point, ortho: null };
}

/**
 * Distance from `p` to the segment `a`-`b`, with the projection clamped to the
 * segment rather than extended along its line.
 *
 * Clamping is what makes this a hit test rather than a line test: without it a
 * click far off the end of a short edge, but level with it, would register as a
 * hit on that edge.
 */
export function pointSegmentDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;

  const t =
    lengthSquared > 0
      ? Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared),
        )
      : 0;

  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The loop edge nearest a click, or null when none is close enough.
 *
 * Hit-tested in screen space, like the ortho lock and the loop-closing snap:
 * the grab band is a statement about how precisely a hand can hold a mouse, so
 * it must not shrink or grow with the geometry. Ties go to the earlier loop and
 * the earlier edge, so a click on a shared corner always picks the same one.
 */
export function pickEdge<K extends string>(
  screen: [number, number],
  loops: { key: K; loop: Point[] }[],
  t: Transform,
  tolerancePx: number = ORTHO_PX,
): { key: K; edge: number } | null {
  let best: { key: K; edge: number } | null = null;
  let bestDistance = tolerancePx;

  for (const { key, loop } of loops) {
    for (let edge = 0; edge < loop.length; edge++) {
      // The closing edge is implicit in a loop, so the last one wraps.
      const a = toScreen(loop[edge], t);
      const b = toScreen(loop[(edge + 1) % loop.length], t);
      const distance = pointSegmentDistance(screen, a, b);

      if (distance < bestDistance) {
        bestDistance = distance;
        best = { key, edge };
      }
    }
  }

  return best;
}

/**
 * Coarsest of 10/20/50 world units that keeps at least `minPx` between labels.
 *
 * Ticks stay at every major grid line; only the numbers thin out, so a narrow
 * window loses labels rather than overlapping them.
 */
export function labelStep(scale: number, minPx = 34): number {
  for (const step of [MAJOR_STEP, 20, 50]) {
    if (step * scale >= minPx) return step;
  }
  return 50;
}
