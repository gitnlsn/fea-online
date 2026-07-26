"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Loop, MeshResponse, Point } from "../lib/mesh";

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

/** World extent shown in the viewport. Geometry is authored inside this box. */
export const WORLD_SIZE = 100;

/** Screen radius, in CSS pixels, for snapping a click to the first vertex. */
const CLOSE_SNAP_PX = 10;

interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function computeTransform(width: number, height: number): Transform {
  const padding = 24;
  const scale = Math.min(
    (width - padding * 2) / WORLD_SIZE,
    (height - padding * 2) / WORLD_SIZE,
  );
  return {
    scale,
    offsetX: (width - WORLD_SIZE * scale) / 2,
    // Flipped so y increases upward, as geometry conventionally does.
    offsetY: height - (height - WORLD_SIZE * scale) / 2,
  };
}

function toScreen(point: Point, t: Transform): [number, number] {
  return [point[0] * t.scale + t.offsetX, t.offsetY - point[1] * t.scale];
}

function toWorld(x: number, y: number, t: Transform): Point {
  return [(x - t.offsetX) / t.scale, (t.offsetY - y) / t.scale];
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

interface MeshCanvasProps {
  boundary: Loop | null;
  holes: Loop[];
  draft: Point[];
  cursor: Point | null;
  mesh: MeshResponse | null;
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
  minAngleDeg,
  showMesh,
  stale,
  selectedRange,
  onCanvasClick,
  onCursorMove,
}: MeshCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<Transform>({ scale: 1, offsetX: 0, offsetY: 0 });

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

    const transform = computeTransform(cssWidth, cssHeight);
    transformRef.current = transform;

    // --- recessive grid ---
    context.strokeStyle = gridline;
    context.lineWidth = 1;
    context.beginPath();
    for (let i = 0; i <= WORLD_SIZE; i += 10) {
      const [xa, ya] = toScreen([i, 0], transform);
      const [xb, yb] = toScreen([i, WORLD_SIZE], transform);
      context.moveTo(xa, ya);
      context.lineTo(xb, yb);

      const [xc, yc] = toScreen([0, i], transform);
      const [xd, yd] = toScreen([WORLD_SIZE, i], transform);
      context.moveTo(xc, yc);
      context.lineTo(xd, yd);
    }
    context.stroke();

    context.strokeStyle = baseline;
    context.lineWidth = 1;
    const [ox, oy] = toScreen([0, 0], transform);
    const [ex] = toScreen([WORLD_SIZE, 0], transform);
    const [, ey] = toScreen([0, WORLD_SIZE], transform);
    context.beginPath();
    context.moveTo(ox, oy);
    context.lineTo(ex, oy);
    context.moveTo(ox, oy);
    context.lineTo(ox, ey);
    context.stroke();

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
        context.fillStyle = qualityColor(angle, minAngleDeg);
        context.fill();

        // A hairline in the surface colour separates adjacent fills, so element
        // boundaries stay legible without a heavy wireframe.
        context.strokeStyle = surface;
        context.lineWidth = 0.5;
        context.stroke();
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
  }, [boundary, holes, draft, cursor, mesh, minAngleDeg, showMesh, stale, selectedRange]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    const parent = canvasRef.current?.parentElement;
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, [draw]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const world = toWorld(x, y, transformRef.current);

    let snapped = false;
    if (draft.length >= 3) {
      const [sx, sy] = toScreen(draft[0], transformRef.current);
      snapped = Math.hypot(sx - x, sy - y) <= CLOSE_SNAP_PX;
    }

    onCanvasClick(world, snapped);
  };

  const handleMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onCursorMove(
      toWorld(event.clientX - rect.left, event.clientY - rect.top, transformRef.current),
    );
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      onMouseMove={handleMove}
      onMouseLeave={() => onCursorMove(null)}
      className="block h-full w-full cursor-crosshair"
    />
  );
}
