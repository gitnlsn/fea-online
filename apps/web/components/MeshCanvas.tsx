"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Loop, MeshResponse, Point } from "../lib/mesh";
import { fieldColor, fieldScale } from "../lib/fieldRamp";
import type { LoopKey, SolveResponse } from "../lib/solve";
import {
  computeTransform,
  labelStep,
  MAJOR_STEP,
  MINOR_STEP,
  pickEdge,
  snapPoint,
  toScreen,
  toWorld,
  WORLD_SIZE,
  type Transform,
} from "../lib/viewport";

/** Sequential blue ramp: element quality, low angle to high angle. */
const QUALITY_RAMP = [
  "#cde2fb",
  "#9ec5f4",
  "#6da7ec",
  "#3987e5",
  "#256abf",
  "#184f95",
  "#0d366b",
];

const STATUS_CRITICAL = "#d03b3b";

/** Screen radius, in CSS pixels, for snapping a click to the first vertex. */
const CLOSE_SNAP_PX = 10;

/** Length of a ruler tick outside the plot box, in CSS pixels. */
const TICK_PX = 4;

/**
 * Rasterises the sampled field into `context`.
 *
 * Kept out of the main draw so it can go to an offscreen buffer, and written
 * against raw numbers rather than the `toScreen` helper: it runs once per
 * element per sub-triangle, and the helper allocates a tuple on every call.
 */
function paintField(
  context: CanvasRenderingContext2D,
  solution: SolveResponse,
  t: Transform,
  neutral: string,
) {
  const { positions, values, sub_triangles, sample_stride } = solution;
  const scale = fieldScale(solution.min_value, solution.max_value);

  for (let element = 0; element < solution.element_count; element++) {
    const base = element * sample_stride;

    for (let corner = 0; corner < sub_triangles.length; corner += 3) {
      const a = (base + sub_triangles[corner]) * 2;
      const b = (base + sub_triangles[corner + 1]) * 2;
      const c = (base + sub_triangles[corner + 2]) * 2;

      context.beginPath();
      context.moveTo(positions[a] * t.scale + t.offsetX, t.offsetY - positions[a + 1] * t.scale);
      context.lineTo(positions[b] * t.scale + t.offsetX, t.offsetY - positions[b + 1] * t.scale);
      context.lineTo(positions[c] * t.scale + t.offsetX, t.offsetY - positions[c + 1] * t.scale);
      context.closePath();

      // The sub-triangle takes one colour, from the mean of its corners. A flat
      // fill of a sampled polynomial is what "subdivide until flat is close
      // enough" means; averaging the corners rather than taking one of them
      // keeps the fill centred on the patch it covers.
      const value =
        (values[base + sub_triangles[corner]] +
          values[base + sub_triangles[corner + 1]] +
          values[base + sub_triangles[corner + 2]]) /
        3;
      const color = fieldColor(value, scale, neutral);

      context.fillStyle = color;
      context.fill();
      // Antialiasing leaves a hairline of background between adjacent fills,
      // which reads as a crack in the solution rather than as a canvas
      // artefact. Stroking the same path in the same colour closes it.
      context.strokeStyle = color;
      context.lineWidth = 0.5;
      context.stroke();
    }
  }
}

function qualityColor(minAngleDeg: number, targetDeg: number): string {
  // Elements that miss the requested quality are called out in the reserved
  // status colour. The stats panel always shows the matching count and label,
  // so this never conveys meaning by colour alone.
  if (minAngleDeg < targetDeg) return STATUS_CRITICAL;

  // Above target, shade by how much headroom the element has, up to the
  // equilateral maximum of 60 degrees.
  const span = Math.max(1e-6, 60 - targetDeg);
  const fraction = Math.min(1, Math.max(0, (minAngleDeg - targetDeg) / span));
  const index = Math.min(
    QUALITY_RAMP.length - 1,
    Math.floor(fraction * QUALITY_RAMP.length),
  );
  return QUALITY_RAMP[index];
}

/** An edge of a drawn loop, as the boundary-condition editor identifies it. */
export interface EdgeRef {
  key: LoopKey;
  edge: number;
}

interface MeshCanvasProps {
  boundary: Loop | null;
  holes: Loop[];
  draft: Point[];
  cursor: Point | null;
  mesh: MeshResponse | null;
  /**
   * The solved field, sampled for display. Drawn beneath the mesh, and
   * suppresses the mesh's own quality fill while it is showing: two sequential
   * fills in the same pixels answer different questions and neither survives
   * being read through the other.
   */
  solution: SolveResponse | null;
  showField: boolean;
  /**
   * The field belongs to a problem that has since changed -- different
   * conditions, or a different mesh. Drawn faintly for the same reason a stale
   * mesh is.
   */
  fieldStale: boolean;
  /** Clicking an edge selects it, rather than placing a geometry point. */
  edgePickEnabled: boolean;
  selectedEdge: EdgeRef | null;
  onEdgePick: (edge: EdgeRef) => void;
  minAngleDeg: number;
  showMesh: boolean;
  /**
   * The mesh belongs to geometry that has since changed. Drawn faintly rather
   * than at full strength, so it reads as "being replaced" instead of as the
   * current mesh disagreeing with the outline it is drawn against.
   */
  stale: boolean;
  /**
   * Angle range selected in the histogram, in degrees. Elements outside it are
   * pushed back so the selected ones read as a group -- this is what turns
   * "some elements are bad" into "those elements, there".
   */
  selectedRange: [number, number] | null;
  onCanvasClick: (point: Point, snappedToStart: boolean) => void;
  onCursorMove: (point: Point | null) => void;
}

export function MeshCanvas({
  boundary,
  holes,
  draft,
  cursor,
  mesh,
  solution,
  showField,
  fieldStale,
  edgePickEnabled,
  selectedEdge,
  onEdgePick,
  minAngleDeg,
  showMesh,
  stale,
  selectedRange,
  onCanvasClick,
  onCursorMove,
}: MeshCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<Transform>({ scale: 1, offsetX: 0, offsetY: 0 });

  /**
   * The field, rasterised once and blitted thereafter.
   *
   * `draw` re-runs on every mouse move, because the rubber band depends on the
   * cursor. A field at a few thousand elements is tens of thousands of filled
   * paths, which is far too much to repaint at pointer rate -- so it is drawn
   * into an offscreen canvas and invalidated only when the field or the
   * viewport actually changes.
   */
  const fieldCacheRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);

  /**
   * The edge the pointer is over.
   *
   * State rather than a ref, even though the move handler fires at pointer rate:
   * the handler only calls the setter when the hovered edge actually *changes*,
   * so this re-renders on the order of once per edge crossed, and both the
   * highlight and the cursor swap follow from it without a manual repaint.
   */
  const [hoveredEdge, setHoveredEdge] = useState<EdgeRef | null>(null);

  const loops = useMemo(
    () => [
      ...(boundary ? [{ key: "boundary" as LoopKey, loop: boundary }] : []),
      ...holes.map((hole, index) => ({ key: `hole:${index}` as LoopKey, loop: hole })),
    ],
    [boundary, holes],
  );

  /**
   * Alt releases snapping. Held in state rather than read off each mouse event
   * alone, because pressing the key without moving the mouse still has to
   * redraw -- otherwise the rubber band keeps showing a snapped preview that no
   * longer matches where a click would land.
   */
  const [altHeld, setAltHeld] = useState(false);
  const snapEnabled = !altHeld;

  /** The point a segment is being drawn from, and so what ortho locks against. */
  const anchor = draft.length > 0 ? draft[draft.length - 1] : null;

  /**
   * Axis the pending segment runs along, or null if it is not axis-aligned.
   *
   * Derived from the cursor already in state rather than remembered from the
   * last snap, so the guide line can never disagree with the rubber band it is
   * meant to explain.
   */
  const orthoAxis =
    anchor && cursor && snapEnabled
      ? cursor[1] === anchor[1]
        ? "x"
        : cursor[0] === anchor[0]
          ? "y"
          : null
      : null;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const cssWidth = parent.clientWidth;
    const cssHeight = parent.clientHeight;
    // Backing store is scaled for the display so lines stay crisp; all drawing
    // below is then done in CSS pixels.
    const ratio = window.devicePixelRatio || 1;

    if (canvas.width !== cssWidth * ratio || canvas.height !== cssHeight * ratio) {
      canvas.width = cssWidth * ratio;
      canvas.height = cssHeight * ratio;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    const styles = getComputedStyle(document.documentElement);
    const gridline = styles.getPropertyValue("--gridline").trim() || "#e1e0d9";
    const baseline = styles.getPropertyValue("--baseline").trim() || "#c3c2b7";
    const series = styles.getPropertyValue("--series-1").trim() || "#2a78d6";
    const surface = styles.getPropertyValue("--surface").trim() || "#fcfcfb";
    const primary = styles.getPropertyValue("--text-primary").trim() || "#0b0b0b";
    const muted = styles.getPropertyValue("--text-muted").trim() || "#898781";

    const transform = computeTransform(cssWidth, cssHeight);
    transformRef.current = transform;

    const [ox, oy] = toScreen([0, 0], transform);
    const [ex, ey] = toScreen([WORLD_SIZE, WORLD_SIZE], transform);

    // --- recessive grid ---
    // Minor lines sit between the labelled ones so a one-unit snap has
    // something to be read against; they are drawn faintly enough to stay
    // background texture rather than competing with the mesh.
    const gridPass = (step: number, alpha: number) => {
      context.strokeStyle = gridline;
      context.globalAlpha = alpha;
      context.lineWidth = 1;
      context.beginPath();
      for (let i = 0; i <= WORLD_SIZE; i += step) {
        if (step === MINOR_STEP && i % MAJOR_STEP === 0) continue;
        const [x] = toScreen([i, 0], transform);
        context.moveTo(x, oy);
        context.lineTo(x, ey);

        const [, y] = toScreen([0, i], transform);
        context.moveTo(ox, y);
        context.lineTo(ex, y);
      }
      context.stroke();
      context.globalAlpha = 1;
    };

    gridPass(MINOR_STEP, 0.45);
    gridPass(MAJOR_STEP, 1);

    context.strokeStyle = baseline;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(ox, oy);
    context.lineTo(ex, oy);
    context.moveTo(ox, oy);
    context.lineTo(ox, ey);
    context.stroke();

    // --- rulers ---
    // Ticks mark every major grid line; only the numbers thin out as the canvas
    // narrows, so the scale stays readable even where a label was dropped.
    const numberEvery = labelStep(transform.scale);

    context.strokeStyle = baseline;
    context.lineWidth = 1;
    context.beginPath();
    for (let i = 0; i <= WORLD_SIZE; i += MAJOR_STEP) {
      const [x] = toScreen([i, 0], transform);
      context.moveTo(x, oy);
      context.lineTo(x, oy + TICK_PX);

      const [, y] = toScreen([0, i], transform);
      context.moveTo(ox, y);
      context.lineTo(ox - TICK_PX, y);
    }
    context.stroke();

    context.fillStyle = muted;
    context.font = "10px system-ui, -apple-system, sans-serif";
    for (let i = 0; i <= WORLD_SIZE; i += numberEvery) {
      const [x] = toScreen([i, 0], transform);
      context.textAlign = "center";
      context.textBaseline = "top";
      context.fillText(String(i), x, oy + TICK_PX + 3);

      const [, y] = toScreen([0, i], transform);
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(String(i), ox - TICK_PX - 3, y);
    }

    // --- solution field ---
    // Drawn under the mesh so element edges read as an overlay on the field
    // rather than the field bleeding over them.
    const fieldShowing = solution !== null && showField;
    if (fieldShowing) {
      const neutral = styles.getPropertyValue("--div-mid").trim() || "#f0efec";
      const cacheKey = JSON.stringify([
        solution.positions.length,
        solution.min_value,
        solution.max_value,
        solution.element_count,
        solution.subdivisions,
        transform,
        neutral,
        ratio,
        cssWidth,
        cssHeight,
      ]);

      let cached = fieldCacheRef.current;
      if (!cached || cached.key !== cacheKey) {
        const buffer = document.createElement("canvas");
        buffer.width = cssWidth * ratio;
        buffer.height = cssHeight * ratio;
        const target = buffer.getContext("2d");
        if (target) {
          target.setTransform(ratio, 0, 0, ratio, 0, 0);
          paintField(target, solution, transform, neutral);
        }
        cached = { key: cacheKey, canvas: buffer };
        fieldCacheRef.current = cached;
      }

      // A field on a stale mesh is at least as out of date as the mesh, so the
      // two flags compound rather than one overriding the other.
      context.globalAlpha = fieldStale || stale ? 0.2 : 1;
      context.drawImage(cached.canvas, 0, 0, cssWidth, cssHeight);
      context.globalAlpha = 1;
    }

    // --- mesh ---
    if (mesh && showMesh) {
      const { vertices, triangles, min_angles_deg } = mesh;

      // Selected elements are drawn in a second pass so their outlines sit on
      // top of neighbouring fills instead of being overdrawn by them.
      const selected: number[] = [];

      for (let t = 0; t < triangles.length; t += 3) {
        const element = t / 3;
        const angle = min_angles_deg[element];
        const inSelection =
          selectedRange !== null &&
          angle >= selectedRange[0] &&
          angle < selectedRange[1];

        if (selectedRange !== null && inSelection) selected.push(element);

        const ia = triangles[t] * 2;
        const ib = triangles[t + 1] * 2;
        const ic = triangles[t + 2] * 2;

        const [ax, ay] = toScreen([vertices[ia], vertices[ia + 1]], transform);
        const [bx, by] = toScreen([vertices[ib], vertices[ib + 1]], transform);
        const [cx, cy] = toScreen([vertices[ic], vertices[ic + 1]], transform);

        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(bx, by);
        context.lineTo(cx, cy);
        context.closePath();

        // Unselected elements recede rather than disappearing, so the mesh
        // stays readable as context around the selection.
        const selectionAlpha = selectedRange === null || inSelection ? 1 : 0.25;
        context.globalAlpha = stale ? selectionAlpha * 0.2 : selectionAlpha;

        if (!fieldShowing) {
          context.fillStyle = qualityColor(angle, minAngleDeg);
          context.fill();

          // A hairline in the surface colour separates adjacent fills, so
          // element boundaries stay legible without a heavy wireframe.
          context.strokeStyle = surface;
          context.lineWidth = 0.5;
          context.stroke();
        } else {
          // Over a field the wireframe is all that is left of the mesh, and it
          // has to stay recessive: element edges are context here, not the
          // subject.
          context.strokeStyle = baseline;
          context.lineWidth = 0.5;
          context.globalAlpha *= 0.5;
          context.stroke();
        }
        context.globalAlpha = 1;
      }

      for (const element of selected) {
        const t = element * 3;
        const ia = triangles[t] * 2;
        const ib = triangles[t + 1] * 2;
        const ic = triangles[t + 2] * 2;

        const [ax, ay] = toScreen([vertices[ia], vertices[ia + 1]], transform);
        const [bx, by] = toScreen([vertices[ib], vertices[ib + 1]], transform);
        const [cx, cy] = toScreen([vertices[ic], vertices[ic + 1]], transform);

        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(bx, by);
        context.lineTo(cx, cy);
        context.closePath();
        context.strokeStyle = primary;
        context.lineWidth = 1.5;
        context.stroke();
      }
    }

    // --- geometry outlines ---
    const strokeLoop = (loop: Loop, color: string, width: number) => {
      if (loop.length < 2) return;
      context.strokeStyle = color;
      context.lineWidth = width;
      context.beginPath();
      loop.forEach((point, index) => {
        const [x, y] = toScreen(point, transform);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      context.stroke();
    };

    if (boundary) strokeLoop(boundary, series, 2);
    holes.forEach((hole) => strokeLoop(hole, series, 2));

    // --- picked edges ---
    // Drawn over the outlines rather than instead of them, so an edge under the
    // pointer reads as a highlight on the loop rather than as a break in it. A
    // pickable target the user cannot see is the same problem the ortho guide
    // exists to solve.
    if (edgePickEnabled) {
      const highlight = (edge: EdgeRef | null, color: string, width: number) => {
        if (!edge) return;
        const found = loops.find((entry) => entry.key === edge.key);
        if (!found || edge.edge >= found.loop.length) return;

        const [ax, ay] = toScreen(found.loop[edge.edge], transform);
        const [bx, by] = toScreen(found.loop[(edge.edge + 1) % found.loop.length], transform);

        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(bx, by);
        context.lineCap = "round";
        context.strokeStyle = color;
        context.lineWidth = width;
        context.stroke();
        context.lineCap = "butt";
      };

      highlight(hoveredEdge, primary, 4);
      highlight(selectedEdge, primary, 5);
    }

    // --- ortho guide ---
    // A snap the user cannot see reads as the tool moving their point for no
    // reason, so the locked axis is drawn as a full-width dashed line.
    if (anchor && orthoAxis) {
      const [ax, ay] = toScreen(anchor, transform);
      context.save();
      context.strokeStyle = baseline;
      context.lineWidth = 1;
      context.setLineDash([4, 4]);
      context.beginPath();
      if (orthoAxis === "x") {
        context.moveTo(ox, ay);
        context.lineTo(ex, ay);
      } else {
        context.moveTo(ax, oy);
        context.lineTo(ax, ey);
      }
      context.stroke();
      context.restore();
    }

    // --- in-progress draft ---
    if (draft.length > 0) {
      context.strokeStyle = series;
      context.lineWidth = 2;
      context.beginPath();
      draft.forEach((point, index) => {
        const [x, y] = toScreen(point, transform);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      if (cursor) {
        const [x, y] = toScreen(cursor, transform);
        context.lineTo(x, y);
      }
      context.stroke();

      for (const point of draft) {
        const [x, y] = toScreen(point, transform);
        context.beginPath();
        context.arc(x, y, 4, 0, Math.PI * 2);
        context.fillStyle = series;
        context.fill();
        context.strokeStyle = surface;
        context.lineWidth = 2;
        context.stroke();
      }

      // Highlight the closing target once a loop is possible.
      if (draft.length >= 3) {
        const [x, y] = toScreen(draft[0], transform);
        context.beginPath();
        context.arc(x, y, 8, 0, Math.PI * 2);
        context.strokeStyle = series;
        context.lineWidth = 2;
        context.stroke();
      }
    }
  }, [
    boundary,
    holes,
    loops,
    draft,
    cursor,
    mesh,
    solution,
    showField,
    fieldStale,
    edgePickEnabled,
    selectedEdge,
    hoveredEdge,
    minAngleDeg,
    showMesh,
    stale,
    selectedRange,
    anchor,
    orthoAxis,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    const parent = canvasRef.current?.parentElement;
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, [draw]);

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setAltHeld(event.altKey);
    // Alt-tabbing away leaves the keyup unheard, which would strand snapping in
    // the released state until the key is pressed and let go again.
    const release = () => setAltHeld(false);

    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", release);
    };
  }, []);

  /**
   * Where a click at these canvas coordinates would actually place a point.
   *
   * Shared by the click and move handlers so the rubber-band preview and the
   * committed point can never differ.
   */
  const resolve = (event: React.MouseEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const transform = transformRef.current;
    const raw = toWorld(event.clientX - rect.left, event.clientY - rect.top, transform);
    // `event.altKey` rather than the tracked state: the event is the newer of
    // the two when a mouse move and a key press race.
    return snapPoint(raw, anchor, transform.scale, !event.altKey).point;
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Edge picking is checked first and returns early, so a click made while
    // assigning boundary conditions can never fall through and place a geometry
    // point instead. The two modes are exclusive by construction rather than by
    // the caller remembering to disable one.
    if (edgePickEnabled) {
      const picked = pickEdge([x, y], loops, transformRef.current);
      if (picked) onEdgePick(picked);
      return;
    }

    // Closing the loop is checked against the raw pointer position and takes
    // priority: snapping must not be able to pull a click off the first vertex
    // and quietly add a duplicate point instead of finishing the loop.
    if (draft.length >= 3) {
      const [sx, sy] = toScreen(draft[0], transformRef.current);
      if (Math.hypot(sx - x, sy - y) <= CLOSE_SNAP_PX) {
        onCanvasClick(draft[0], true);
        return;
      }
    }

    onCanvasClick(resolve(event), false);
  };

  const handleMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (edgePickEnabled) {
      const rect = event.currentTarget.getBoundingClientRect();
      const picked = pickEdge(
        [event.clientX - rect.left, event.clientY - rect.top],
        loops,
        transformRef.current,
      );

      // Only set when the hovered edge actually changes. The handler fires at
      // pointer rate, and re-rendering on every event would undo the point of
      // caching the field.
      setHoveredEdge((previous) =>
        previous?.key === picked?.key && previous?.edge === picked?.edge
          ? previous
          : picked,
      );

      // No rubber band while picking, so the cursor position is not tracked.
      return;
    }

    onCursorMove(resolve(event));
  };

  const hovering = edgePickEnabled && hoveredEdge !== null;

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      onMouseMove={handleMove}
      onMouseLeave={() => {
        if (edgePickEnabled) {
          setHoveredEdge(null);
          return;
        }
        onCursorMove(null);
      }}
      className={`block h-full w-full ${hovering ? "cursor-pointer" : "cursor-crosshair"}`}
    />
  );
}
