export type Point = [number, number];

/** A closed loop of points. The closing edge is implicit. */
export type Loop = Point[];

export interface MeshRequest {
  boundary: Loop;
  holes: Loop[];
  min_angle_deg: number;
  max_area?: number | null;
  max_steps?: number | null;
  /**
   * Element ceiling. Primarily a memory bound; omitting it takes the mesher's
   * own `RefineParams::DEFAULT_MAX_TRIANGLES`.
   */
  max_triangles?: number | null;
}

export interface MeshResponse {
  /** Interleaved [x0, y0, x1, y1, ...] in the same units as the input. */
  vertices: number[];
  /** Interleaved corner indices [i0, j0, k0, ...]. */
  triangles: number[];
  /** Smallest interior angle per triangle, in degrees. */
  min_angles_deg: number[];
  vertex_count: number;
  triangle_count: number;
  min_angle_deg: number | null;
  /** Triangle counts per 5-degree bucket over 0..60. */
  angle_histogram: number[];
  /**
   * Refinement bailed out rather than converging. The mesh is still valid but
   * does not meet the requested quality everywhere.
   */
  terminated_early: boolean;
  /**
   * How many elements refinement ran out of moves on.
   *
   * Zero unless the outcome is `left_unimprovable`. Distinct from the count of
   * elements below the target angle, which is a property of the finished mesh:
   * this is the number that says the target is unreachable rather than merely
   * unmet.
   */
  unimprovable_elements: number;
  /** Mirrors `outcome_label` in `crates/fea-wasm/src/lib.rs`. */
  outcome:
    | "converged"
    | "hit_step_limit"
    | "hit_size_limit"
    | "left_unimprovable";
  /**
   * Whether the quality target sits inside Ruppert's provable-termination
   * regime (roughly, a minimum angle at or below 20.7 degrees).
   */
  provable_termination: boolean;
}

/**
 * Stable identity for a mesh request: same inputs, same key.
 *
 * Used to tell whether the mesh on screen still belongs to the geometry
 * currently drawn. A mesh deliberately survives across recomputations so the
 * canvas does not flicker on every slider step, which means it can outlive the
 * geometry that produced it -- and a good mesh of the *previous* shape, drawn
 * against the current outline, is indistinguishable from a corrupt one.
 *
 * `max_steps` and `max_triangles` are excluded on purpose: they bound how hard
 * the mesher tries, not what is being meshed, so a change to them alone does
 * not make an existing mesh describe the wrong geometry.
 */
export function meshRequestKey(request: MeshRequest): string {
  return JSON.stringify([
    request.boundary,
    request.holes,
    request.min_angle_deg,
    request.max_area ?? null,
  ]);
}

export type WorkerRequest = { id: number; request: MeshRequest };

export type WorkerResponse =
  | { id: number; ok: true; result: MeshResponse; elapsedMs: number }
  | { id: number; ok: false; error: string };

/** Signed area via the shoelace formula; positive means counter-clockwise. */
export function signedArea(loop: Loop): number {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

/**
 * Whether a loop self-intersects.
 *
 * The mesher requires simple polygons, and a self-intersecting boundary
 * otherwise surfaces as a confusing failure deep inside segment recovery rather
 * than as something the user can act on.
 */
export function selfIntersects(loop: Loop): boolean {
  const n = loop.length;
  if (n < 4) return false;

  const crosses = (a: Point, b: Point, c: Point) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  const properlyIntersect = (a: Point, b: Point, c: Point, d: Point) => {
    const d1 = crosses(a, b, c);
    const d2 = crosses(a, b, d);
    const d3 = crosses(c, d, a);
    const d4 = crosses(c, d, b);
    return (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    );
  };

  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share a vertex by construction, so skip them rather than
      // reporting that shared endpoint as an intersection.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (properlyIntersect(a, b, loop[j], loop[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Human-readable reason a loop cannot be meshed, or null when it is fine. */
export function validateLoop(loop: Loop, label: string): string | null {
  if (loop.length < 3) return `${label} needs at least 3 points.`;

  // Self-intersection is checked before area, not after. A bow-tie encloses
  // exactly zero signed area because its two lobes cancel, so an area-first
  // order reports "encloses no area" -- true, but it sends the user looking for
  // a degenerate polygon instead of the crossing edges that actually caused it.
  if (selfIntersects(loop)) return `${label} intersects itself.`;
  if (Math.abs(signedArea(loop)) < 1e-12) return `${label} encloses no area.`;
  return null;
}

/**
 * Smallest interior angle of a loop, in degrees.
 *
 * Sharp input corners are the practical limit on mesh quality: Ruppert's
 * algorithm is not guaranteed to terminate when two input segments meet below
 * about 60 degrees, so surfacing the worst corner explains why a refinement run
 * stalled far better than a generic failure message.
 */
export function loopCornerAngles(loop: Loop): number[] {
  const n = loop.length;
  return loop.map((_, i) => {
    const prev = loop[(i - 1 + n) % n];
    const here = loop[i];
    const next = loop[(i + 1) % n];

    const ax = prev[0] - here[0];
    const ay = prev[1] - here[1];
    const bx = next[0] - here[0];
    const by = next[1] - here[1];

    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) return 0;

    const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
    return (Math.acos(cos) * 180) / Math.PI;
  });
}
