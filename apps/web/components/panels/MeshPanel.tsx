"use client";

import { AngleHistogram } from "../AngleHistogram";
import { CheckField, SliderField, Stat } from "../controls";
import type { MeshResponse } from "../../lib/mesh";

interface MeshPanelProps {
  minAngleDeg: number;
  onMinAngleChange: (next: number) => void;
  maxAreaPercent: number;
  onMaxAreaChange: (next: number) => void;
  showMesh: boolean;
  onShowMeshChange: (next: boolean) => void;

  mesh: MeshResponse | null;
  /** The mesh on screen was built from geometry that has since changed. */
  stale: boolean;
  meshing: boolean;
  elapsedMs: number;

  /** Elements failing the requested minimum angle. */
  belowTarget: number;
  selectedBucket: [number, number] | null;
  selectedCount: number;
  onSelectBucket: (next: [number, number] | null) => void;
}

/**
 * What the mesher was asked for, and what it produced.
 *
 * The request and the result share a panel because neither means much alone: a
 * worst angle of 29° is good or bad only against the target that was set, and
 * moving that target is the response to reading it.
 */
export function MeshPanel({
  minAngleDeg,
  onMinAngleChange,
  maxAreaPercent,
  onMaxAreaChange,
  showMesh,
  onShowMeshChange,
  mesh,
  stale,
  meshing,
  elapsedMs,
  belowTarget,
  selectedBucket,
  selectedCount,
  onSelectBucket,
}: MeshPanelProps) {
  return (
    <>
      <SliderField
        label="Minimum angle"
        display={`${minAngleDeg}°`}
        value={minAngleDeg}
        min={5}
        max={34}
        step={1}
        onChange={onMinAngleChange}
      >
        {minAngleDeg > 20.7 && (
          <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Above 20.7° Ruppert&apos;s algorithm is no longer provably
            terminating — refinement is best-effort here.
          </p>
        )}
      </SliderField>

      <SliderField
        label="Max element area"
        display={`${maxAreaPercent.toFixed(2)}%`}
        value={maxAreaPercent}
        min={0.05}
        max={5}
        step={0.05}
        onChange={onMaxAreaChange}
      />

      <CheckField label="Show mesh" checked={showMesh} onChange={onShowMeshChange} />

      {mesh && (
        <>
          {/* Numbers below describe the previous geometry until the new mesh
              lands, so they are dimmed rather than shown as current. */}
          <dl
            className="grid grid-cols-2 gap-x-3 gap-y-2"
            style={{ opacity: stale ? 0.45 : 1 }}
          >
            <Stat label="Elements" value={mesh.triangle_count.toLocaleString()} />
            <Stat label="Nodes" value={mesh.vertex_count.toLocaleString()} />
            <Stat
              label="Worst angle"
              // Explicit null check: a worst angle of exactly 0 is both possible
              // (degenerate sliver) and the most important case to show, so it
              // must not be swallowed as falsy.
              value={mesh.min_angle_deg != null ? `${mesh.min_angle_deg.toFixed(2)}°` : "—"}
            />
            <Stat label="Meshed in" value={meshing ? "…" : `${elapsedMs.toFixed(0)} ms`} />
          </dl>

          {belowTarget > 0 && (
            <p className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: "var(--status-critical)" }}
              />
              <span style={{ color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--text-primary)" }}>
                  {belowTarget.toLocaleString()}
                </strong>{" "}
                element{belowTarget === 1 ? "" : "s"} below {minAngleDeg}°
              </span>
            </p>
          )}

          <AngleHistogram
            buckets={mesh.angle_histogram}
            targetDeg={minAngleDeg}
            selected={selectedBucket}
            onSelectBucket={onSelectBucket}
          />

          {selectedBucket && (
            <p className="flex items-baseline justify-between text-xs">
              <span style={{ color: "var(--text-secondary)" }}>
                Highlighting{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                  {selectedCount.toLocaleString()}
                </strong>{" "}
                element{selectedCount === 1 ? "" : "s"} at{" "}
                {selectedBucket[0].toFixed(0)}–{selectedBucket[1].toFixed(0)}°
              </span>
              <button
                type="button"
                onClick={() => onSelectBucket(null)}
                className="underline"
                style={{ color: "var(--text-muted)" }}
              >
                clear
              </button>
            </p>
          )}
        </>
      )}
    </>
  );
}
