"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AngleHistogram } from "../components/AngleHistogram";
import { MeshCanvas } from "../components/MeshCanvas";
import { meshRequestKey, useMesher } from "../hooks/useMesher";
import { WORLD_SIZE } from "../lib/viewport";
import {
  download,
  parseGeometryJson,
  toGeometryJson,
  toGmsh,
  toVtk,
} from "../lib/export";
import { loopCornerAngles, validateLoop, type Loop, type Point } from "../lib/mesh";

type Mode = "idle" | "boundary" | "hole";

/**
 * Convex outer boundary with a rectangular hole.
 *
 * Deliberately not a notched shape. A reflex corner stresses the kernel's
 * segment-recovery path, which still has a hash-order-dependent failure (see
 * `known_issues::repeated_identical_requests_are_stable` in `fea-wasm`): the
 * same request succeeds roughly 27 times out of 28 and then allocates without
 * bound. This shape meshes reliably across hundreds of repeats, so the tool
 * opens on something that works. Drawing a reflex corner by hand can still
 * trip it.
 */
const SAMPLE_BOUNDARY: Loop = [
  [15, 15],
  [85, 15],
  [85, 70],
  [15, 70],
];

const SAMPLE_HOLE: Loop = [
  [38, 30],
  [58, 30],
  [58, 48],
  [38, 48],
];

/** Slider changes are coalesced so a drag issues one mesh per pause, not per pixel. */
const REMESH_DEBOUNCE_MS = 120;

export default function Page() {
  const [boundary, setBoundary] = useState<Loop | null>(SAMPLE_BOUNDARY);
  const [holes, setHoles] = useState<Loop[]>([SAMPLE_HOLE]);
  const [draft, setDraft] = useState<Point[]>([]);
  const [mode, setMode] = useState<Mode>("idle");
  const [cursor, setCursor] = useState<Point | null>(null);

  const [minAngleDeg, setMinAngleDeg] = useState(25);
  const [maxAreaPercent, setMaxAreaPercent] = useState(1.0);
  const [showMesh, setShowMesh] = useState(true);
  const [selectedBucket, setSelectedBucket] = useState<[number, number] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { status, mesh, error, elapsedMs, meshKey, run, clear } = useMesher();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const geometryError = useMemo(() => {
    if (!boundary) return null;
    const boundaryProblem = validateLoop(boundary, "The boundary");
    if (boundaryProblem) return boundaryProblem;

    for (let i = 0; i < holes.length; i++) {
      const holeProblem = validateLoop(holes[i], `Hole ${i + 1}`);
      if (holeProblem) return holeProblem;
    }
    return null;
  }, [boundary, holes]);

  /** Sharp input corners are the usual reason refinement stalls, so name them. */
  const sharpCorners = useMemo(() => {
    if (!boundary) return [];
    const all: { angle: number; where: string }[] = [];

    loopCornerAngles(boundary).forEach((angle, index) => {
      if (angle < 30) all.push({ angle, where: `boundary corner ${index + 1}` });
    });
    holes.forEach((hole, holeIndex) => {
      loopCornerAngles(hole).forEach((angle, index) => {
        if (angle < 30)
          all.push({ angle, where: `hole ${holeIndex + 1} corner ${index + 1}` });
      });
    });

    return all.sort((a, b) => a.angle - b.angle);
  }, [boundary, holes]);

  // Area is expressed as a percentage of the domain's bounding box so the
  // control means the same thing regardless of how large the drawing is.
  const maxArea = useMemo(
    () => (maxAreaPercent / 100) * WORLD_SIZE * WORLD_SIZE,
    [maxAreaPercent],
  );

  /**
   * Whether the mesh on screen was built from the geometry currently drawn.
   *
   * The mesh deliberately survives across recomputations so the canvas does not
   * flicker on every slider step, but that means it can outlive the geometry
   * that produced it -- redraw the boundary and the old mesh keeps rendering
   * against the new outline, which looks exactly like a corrupt mesh. Comparing
   * request identity is what tells the two apart.
   */
  const meshIsStale = useMemo(() => {
    if (!mesh || !boundary || !meshKey) return false;
    return (
      meshKey !==
      meshRequestKey({
        boundary,
        holes,
        min_angle_deg: minAngleDeg,
        max_area: maxArea,
      })
    );
  }, [mesh, meshKey, boundary, holes, minAngleDeg, maxArea]);

  useEffect(() => {
    if (!boundary || geometryError) {
      clear();
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      run({
        boundary,
        holes,
        min_angle_deg: minAngleDeg,
        max_area: maxArea,
        max_steps: 60_000,
      });
    }, REMESH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [boundary, holes, minAngleDeg, maxArea, geometryError, run, clear]);

  const handleCanvasClick = useCallback(
    (point: Point, snappedToStart: boolean) => {
      if (mode === "idle") return;

      if (snappedToStart && draft.length >= 3) {
        if (mode === "boundary") setBoundary(draft);
        else setHoles((previous) => [...previous, draft]);
        setDraft([]);
        setMode("idle");
        return;
      }

      setDraft((previous) => [...previous, point]);
    },
    [mode, draft],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraft([]);
        setMode("idle");
      }
      if (event.key === "Enter" && draft.length >= 3) {
        if (mode === "boundary") setBoundary(draft);
        else if (mode === "hole") setHoles((previous) => [...previous, draft]);
        setDraft([]);
        setMode("idle");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, mode]);

  const belowTarget = useMemo(() => {
    if (!mesh) return 0;
    return mesh.min_angles_deg.filter((angle) => angle < minAngleDeg).length;
  }, [mesh, minAngleDeg]);

  const selectedCount = useMemo(() => {
    if (!mesh || !selectedBucket) return 0;
    return mesh.min_angles_deg.filter(
      (angle) => angle >= selectedBucket[0] && angle < selectedBucket[1],
    ).length;
  }, [mesh, selectedBucket]);

  // A range picked against one mesh means nothing against the next one, so the
  // highlight is dropped whenever the refinement parameters change.
  useEffect(() => {
    setSelectedBucket(null);
  }, [minAngleDeg, maxArea, boundary, holes]);

  const startDrawing = (next: Mode) => {
    setDraft([]);
    setMode(next);
    if (next === "boundary") {
      setBoundary(null);
      setHoles([]);
    }
  };

  return (
    <div className="flex h-screen flex-col" style={{ background: "var(--page)" }}>
      <header
        className="flex items-baseline gap-3 border-b px-4 py-2.5"
        style={{ borderColor: "var(--border)" }}
      >
        <h1 className="text-sm font-semibold">FEA Online</h1>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Constrained Delaunay mesher · Rust + WebAssembly
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 p-3">
          <div
            className="h-full w-full overflow-hidden rounded-lg border"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <MeshCanvas
              boundary={boundary}
              holes={holes}
              draft={draft}
              cursor={cursor}
              mesh={mesh}
              minAngleDeg={minAngleDeg}
              showMesh={showMesh}
              stale={meshIsStale}
              selectedRange={selectedBucket}
              onCanvasClick={handleCanvasClick}
              onCursorMove={setCursor}
            />
          </div>
        </main>

        <aside
          className="w-80 shrink-0 space-y-4 overflow-y-auto border-l p-4"
          style={{ borderColor: "var(--border)" }}
        >
          {/* --- geometry --- */}
          <section>
            <h2
              className="mb-2 text-xs font-semibold tracking-wide uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              Geometry
            </h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => startDrawing("boundary")}
                className="flex-1 rounded border px-2 py-1.5 text-xs transition-colors"
                style={{
                  borderColor: mode === "boundary" ? "var(--series-1)" : "var(--border)",
                  color: mode === "boundary" ? "var(--series-1)" : "var(--text-primary)",
                }}
              >
                Draw boundary
              </button>
              <button
                type="button"
                onClick={() => startDrawing("hole")}
                disabled={!boundary}
                className="flex-1 rounded border px-2 py-1.5 text-xs transition-colors disabled:opacity-40"
                style={{
                  borderColor: mode === "hole" ? "var(--series-1)" : "var(--border)",
                  color: mode === "hole" ? "var(--series-1)" : "var(--text-primary)",
                }}
              >
                Add hole
              </button>
            </div>

            {mode !== "idle" && (
              <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                Click to place points. Points snap to the grid and to the last
                point&apos;s axis — hold Alt to place freely. Click the first point
                again (or press Enter) to close the loop. Escape cancels.
              </p>
            )}

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setBoundary(SAMPLE_BOUNDARY);
                  setHoles([SAMPLE_HOLE]);
                  setDraft([]);
                  setMode("idle");
                }}
                className="text-xs underline"
                style={{ color: "var(--text-muted)" }}
              >
                Reset to sample
              </button>
              {holes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setHoles([])}
                  className="text-xs underline"
                  style={{ color: "var(--text-muted)" }}
                >
                  Clear holes
                </button>
              )}
            </div>
          </section>

          {/* --- quality controls --- */}
          <section className="space-y-3">
            <h2
              className="text-xs font-semibold tracking-wide uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              Refinement
            </h2>

            <label className="block">
              <div className="flex items-baseline justify-between">
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Minimum angle
                </span>
                <span className="tabular text-xs font-medium">{minAngleDeg}°</span>
              </div>
              <input
                type="range"
                min={5}
                max={34}
                step={1}
                value={minAngleDeg}
                onChange={(event) => setMinAngleDeg(Number(event.target.value))}
                className="mt-1 w-full accent-[var(--series-1)]"
              />
              {minAngleDeg > 20.7 && (
                <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Above 20.7° Ruppert&apos;s algorithm is no longer provably
                  terminating — refinement is best-effort here.
                </p>
              )}
            </label>

            <label className="block">
              <div className="flex items-baseline justify-between">
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Max element area
                </span>
                <span className="tabular text-xs font-medium">
                  {maxAreaPercent.toFixed(2)}%
                </span>
              </div>
              <input
                type="range"
                min={0.05}
                max={5}
                step={0.05}
                value={maxAreaPercent}
                onChange={(event) => setMaxAreaPercent(Number(event.target.value))}
                className="mt-1 w-full accent-[var(--series-1)]"
              />
            </label>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showMesh}
                onChange={(event) => setShowMesh(event.target.checked)}
                className="accent-[var(--series-1)]"
              />
              <span style={{ color: "var(--text-secondary)" }}>Show mesh</span>
            </label>
          </section>

          {/* --- problems --- */}
          {geometryError && (
            <div
              className="rounded border p-2 text-xs"
              style={{
                borderColor: "var(--status-critical)",
                color: "var(--status-critical)",
              }}
            >
              <strong>Invalid geometry.</strong> {geometryError}
            </div>
          )}

          {error && !geometryError && (
            <div
              className="rounded border p-2 text-xs"
              style={{
                borderColor: "var(--status-critical)",
                color: "var(--status-critical)",
              }}
            >
              <strong>Meshing failed.</strong> {error}
            </div>
          )}

          {mesh?.terminated_early && (
            <div
              className="rounded border p-2 text-xs"
              style={{
                borderColor: "var(--status-warning)",
                color: "var(--text-secondary)",
              }}
            >
              <strong style={{ color: "var(--text-primary)" }}>
                Refinement stopped early
              </strong>{" "}
              ({mesh.outcome.replace(/_/g, " ")}). The mesh below is valid but does
              not meet {minAngleDeg}° everywhere.
              {sharpCorners.length > 0 && (
                <>
                  {" "}
                  The sharpest input corner is{" "}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {sharpCorners[0].angle.toFixed(1)}° at {sharpCorners[0].where}
                  </strong>
                  — small input angles are the usual cause.
                </>
              )}
            </div>
          )}

          {/* --- results --- */}
          {mesh && (
            <section className="space-y-3">
              <h2
                className="flex items-baseline justify-between text-xs font-semibold tracking-wide uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                <span>Mesh</span>
                {meshIsStale && (
                  <span className="normal-case" style={{ color: "var(--status-warning)" }}>
                    remeshing…
                  </span>
                )}
              </h2>

              {/* Numbers below describe the previous geometry until the new mesh
                  lands, so they are dimmed rather than shown as current. */}
              <dl
                className="grid grid-cols-2 gap-x-3 gap-y-2"
                style={{ opacity: meshIsStale ? 0.45 : 1 }}
              >
                <Stat label="Elements" value={mesh.triangle_count.toLocaleString()} />
                <Stat label="Nodes" value={mesh.vertex_count.toLocaleString()} />
                <Stat
                  label="Worst angle"
                  // Explicit null check: a worst angle of exactly 0 is both
                  // possible (degenerate sliver) and the most important case to
                  // show, so it must not be swallowed as falsy.
                  value={
                    mesh.min_angle_deg != null ? `${mesh.min_angle_deg.toFixed(2)}°` : "—"
                  }
                />
                <Stat
                  label="Meshed in"
                  value={status === "meshing" ? "…" : `${elapsedMs.toFixed(0)} ms`}
                />
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
                onSelectBucket={setSelectedBucket}
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
                    onClick={() => setSelectedBucket(null)}
                    className="underline"
                    style={{ color: "var(--text-muted)" }}
                  >
                    clear
                  </button>
                </p>
              )}
            </section>
          )}

          {/* --- export --- */}
          <section>
            <h2
              className="mb-2 text-xs font-semibold tracking-wide uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              Export
            </h2>
            <div className="flex flex-wrap gap-2">
              <ExportButton
                label="Gmsh .msh"
                disabled={!mesh}
                onClick={() => mesh && download("mesh.msh", toGmsh(mesh))}
              />
              <ExportButton
                label="VTK .vtk"
                disabled={!mesh}
                onClick={() => mesh && download("mesh.vtk", toVtk(mesh))}
              />
              <ExportButton
                label="Geometry .json"
                disabled={!boundary}
                onClick={() =>
                  download(
                    "geometry.json",
                    toGeometryJson({
                      version: 1,
                      boundary,
                      holes,
                      minAngleDeg,
                      maxAreaPercent,
                    }),
                  )
                }
              />
              <label
                className="cursor-pointer rounded border px-2 py-1 text-xs"
                style={{ borderColor: "var(--border)" }}
              >
                Load .json
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const result = parseGeometryJson(await file.text());
                    // Reset the input so picking the same file twice re-fires.
                    event.target.value = "";

                    if (typeof result === "string") {
                      setLoadError(result);
                      return;
                    }
                    setLoadError(null);
                    setBoundary(result.boundary);
                    setHoles(result.holes);
                    setMinAngleDeg(result.minAngleDeg);
                    setMaxAreaPercent(result.maxAreaPercent);
                    setDraft([]);
                    setMode("idle");
                  }}
                />
              </label>
            </div>
            {loadError && (
              <p className="mt-1 text-xs" style={{ color: "var(--status-critical)" }}>
                {loadError}
              </p>
            )}
          </section>

          {sharpCorners.length > 0 && (
            <section>
              <h2
                className="mb-1 text-xs font-semibold tracking-wide uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                Sharp input corners
              </h2>
              <ul
                className="space-y-0.5 text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
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
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function ExportButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded border px-2 py-1 text-xs disabled:opacity-40"
      style={{ borderColor: "var(--border)" }}
    >
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {label}
      </dt>
      <dd className="tabular text-sm font-medium">{value}</dd>
    </div>
  );
}
