"use client";

import type { Loop } from "../../lib/mesh";

export type Mode = "idle" | "boundary" | "hole";

export interface SharpCorner {
  angle: number;
  where: string;
}

interface GeometryPanelProps {
  mode: Mode;
  boundary: Loop | null;
  holes: Loop[];
  /** Input corners tight enough to bound the quality reachable near them. */
  sharpCorners: SharpCorner[];
  onStartDrawing: (next: Mode) => void;
  onResetToSample: () => void;
  onClearHoles: () => void;
}

/**
 * The drawing itself: what is being drawn, and what about it will cause trouble.
 *
 * The sharp-corner list belongs here rather than beside the mesh statistics
 * because it is a fact about the input, not about the mesh -- the corner is
 * sharp before anything is meshed, and no refinement setting will fix it.
 */
export function GeometryPanel({
  mode,
  boundary,
  holes,
  sharpCorners,
  onStartDrawing,
  onResetToSample,
  onClearHoles,
}: GeometryPanelProps) {
  return (
    <>
      <div className="flex gap-2">
        <ModeButton
          label="Draw boundary"
          active={mode === "boundary"}
          onClick={() => onStartDrawing("boundary")}
        />
        <ModeButton
          label="Add hole"
          active={mode === "hole"}
          disabled={!boundary}
          onClick={() => onStartDrawing("hole")}
        />
      </div>

      {mode !== "idle" && (
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Click to place points. Points snap to the grid and to the last
          point&apos;s axis — hold Alt to place freely. Click the first point
          again (or press Enter) to close the loop. Escape cancels.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onResetToSample}
          className="text-xs underline"
          style={{ color: "var(--text-muted)" }}
        >
          Reset to sample
        </button>
        {holes.length > 0 && (
          <button
            type="button"
            onClick={onClearHoles}
            className="text-xs underline"
            style={{ color: "var(--text-muted)" }}
          >
            Clear holes
          </button>
        )}
      </div>

      {sharpCorners.length > 0 && (
        <div>
          <h3 className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
            Sharp input corners
          </h3>
          <ul className="space-y-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
            {sharpCorners.slice(0, 4).map((corner) => (
              <li key={corner.where} className="tabular flex justify-between">
                <span>{corner.where}</span>
                <span>{corner.angle.toFixed(1)}°</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Corners below roughly 60° bound the quality that is reachable near
            them, whatever the target.
          </p>
        </div>
      )}
    </>
  );
}

function ModeButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex-1 rounded border px-2 py-1.5 text-xs transition-colors disabled:opacity-40"
      style={{
        borderColor: active ? "var(--series-1)" : "var(--border)",
        color: active ? "var(--series-1)" : "var(--text-primary)",
      }}
    >
      {label}
    </button>
  );
}
