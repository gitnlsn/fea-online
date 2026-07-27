"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AngleHistogram } from "../components/AngleHistogram";
import { FieldLegend } from "../components/FieldLegend";
import { MeshCanvas, type EdgeRef } from "../components/MeshCanvas";
import { SurfaceCanvas } from "../components/SurfaceCanvas";
import { meshRequestKey, useMesher } from "../hooks/useMesher";
import { useSolver } from "../hooks/useSolver";
import { autoZScale } from "../lib/surface";
import { WORLD_SIZE } from "../lib/viewport";
import {
  download,
  parseGeometryJson,
  toGeometryJson,
  toGmsh,
  toVtk,
  toVtkField,
} from "../lib/export";
import { loopCornerAngles, validateLoop, type Loop, type Point } from "../lib/mesh";
import {
  buildSolveGeometry,
  conditionFor,
  DEFAULT_CONDITION,
  loopEntries,
  NO_CONDITIONS,
  reconcileConditions,
  solveRequestKey,
  subdivisionsFor,
  type BoundaryConditions,
  type ConditionKind,
  type ConditionValue,
  type EdgeKey,
  type LoopKey,
} from "../lib/solve";

type Mode = "idle" | "boundary" | "hole";

/** Which projection the viewport is showing. */
type View = "2d" | "3d";

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

  // What the editors write to. Read through the reconciled `conditions` below,
  // never directly: this can still name a loop that has since been redrawn.
  const [storedConditions, setConditions] = useState<BoundaryConditions>(NO_CONDITIONS);
  const [storedSelectedEdge, setSelectedEdge] = useState<EdgeRef | null>(null);
  const [editingConditions, setEditingConditions] = useState(false);
  const [conductivity, setConductivity] = useState(1);
  const [sourceValue, setSourceValue] = useState(0);
  const [degree, setDegree] = useState(1);
  const [showField, setShowField] = useState(true);

  const [view, setView] = useState<View>("2d");
  /**
   * Vertical exaggeration, as a multiple of the automatic height.
   *
   * A multiple rather than an absolute scale, because the automatic height
   * already absorbs the field's units -- so this control means the same thing
   * whether the field runs to 100 or to 1e-6, and 1 is always a sensible view.
   */
  const [exaggeration, setExaggeration] = useState(1);

  const { status, mesh, error, elapsedMs, meshKey, run, clear } = useMesher();
  const {
    status: solveStatus,
    solution,
    error: solveError,
    elapsedMs: solveElapsedMs,
    solutionKey,
    run: runSolve,
    clear: clearSolution,
  } = useSolver();
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

  /**
   * The conditions as they apply to the geometry currently drawn.
   *
   * Derived rather than kept in sync by an effect. Conditions outlive individual
   * edits -- a loop-level condition survives its loop being redrawn -- so the
   * two can disagree, and reconciling on read means they cannot disagree for
   * even one render. Editors write to `storedConditions`; everything that
   * *reads* a condition reads this.
   */
  const conditions = useMemo(
    () => reconcileConditions(boundary, holes, storedConditions),
    [boundary, holes, storedConditions],
  );

  /** A selection against edges that no longer exist names nothing. */
  const selectedEdge = useMemo(() => {
    if (!storedSelectedEdge) return null;
    const found = loopEntries(boundary, holes).find(
      (entry) => entry.key === storedSelectedEdge.key,
    );
    return found && storedSelectedEdge.edge < found.loop.length ? storedSelectedEdge : null;
  }, [storedSelectedEdge, boundary, holes]);

  /** The problem as currently stated, or null when there is nothing to solve. */
  const solveRequest = useMemo(() => {
    if (!mesh || !boundary || geometryError) return null;

    return {
      vertices: mesh.vertices,
      triangles: mesh.triangles,
      ...buildSolveGeometry(boundary, holes, conditions),
      conductivity,
      source: { kind: "constant" as const, value: sourceValue },
      degree,
      tolerance: 1e-10,
      max_iterations: 5_000,
      subdivisions: subdivisionsFor(degree),
    };
  }, [mesh, boundary, holes, geometryError, conditions, conductivity, sourceValue, degree]);

  /**
   * Whether the field on screen still answers the problem currently stated.
   *
   * The same reasoning as `meshIsStale`, one layer up: a field is kept on screen
   * while the next solve runs, and while conditions are being edited, so it can
   * outlive the problem that produced it. A correct answer to the previous
   * question looks exactly like a wrong answer to this one.
   */
  const solutionIsStale = useMemo(() => {
    if (!solution || !solutionKey || !solveRequest || !meshKey) return false;
    return solutionKey !== solveRequestKey(solveRequest, meshKey);
  }, [solution, solutionKey, solveRequest, meshKey]);

  // A field computed on geometry that has since been replaced is not stale, it
  // is meaningless -- there is nothing left for it to be drawn against.
  useEffect(() => {
    if (!boundary) clearSolution();
  }, [boundary, clearSolution]);

  const canSolve =
    solveRequest !== null && !meshIsStale && solveStatus !== "solving" && !geometryError;

  /** World units of height per unit of field, as the 3D view draws it. */
  const zScale = useMemo(
    () =>
      solution
        ? autoZScale(solution.min_value, solution.max_value) * exaggeration
        : 1,
    [solution, exaggeration],
  );

  /**
   * The view actually being shown.
   *
   * Derived rather than kept in sync, for the same reason `conditions` is:
   * without a field there is no third dimension to show, and a `view` of "3d"
   * can outlive the solution that justified it -- clear the boundary and the
   * stored choice still says 3D. Resolving on read means the two cannot disagree
   * for even one render, and the switch needs no effect to walk it back.
   */
  const activeView: View = solution ? view : "2d";

  /**
   * Switching to 3D leaves every mode that interprets a click.
   *
   * Drawing and edge-picking are plan-view operations -- there is no sensible
   * meaning for "place a point" on an orbiting surface -- and in 3D a drag has
   * already been claimed by the camera. Leaving the modes on switch is what
   * keeps a click from meaning two things at once, the same invariant the canvas
   * enforces between drawing and edge-picking.
   */
  const showView = useCallback((next: View) => {
    setView(next);
    if (next === "3d") {
      setMode("idle");
      setDraft([]);
      setEditingConditions(false);
      setSelectedEdge(null);
    }
  }, []);

  const handleSolve = useCallback(() => {
    if (!solveRequest || !meshKey) return;
    runSolve(solveRequest, meshKey);
  }, [solveRequest, meshKey, runSolve]);

  const setLoopCondition = useCallback((key: LoopKey, next: ConditionValue) => {
    setConditions((previous) => ({
      ...previous,
      loops: { ...previous.loops, [key]: next },
    }));
  }, []);

  const setEdgeCondition = useCallback((key: EdgeKey, next: ConditionValue) => {
    setConditions((previous) => ({
      ...previous,
      edges: { ...previous.edges, [key]: next },
    }));
  }, []);

  const clearEdgeCondition = useCallback((key: EdgeKey) => {
    setConditions((previous) => {
      const edges = { ...previous.edges };
      delete edges[key];
      return { ...previous, edges };
    });
  }, []);

  /**
   * Clicking an edge splits it out of its loop's group.
   *
   * The override is seeded from whatever the edge already resolves to, so
   * selecting an edge never changes the problem -- only what can be edited.
   */
  const handleEdgePick = useCallback(
    (picked: EdgeRef) => {
      setSelectedEdge(picked);
      const key = `${picked.key}:${picked.edge}` as EdgeKey;
      setConditions((previous) =>
        previous.edges[key]
          ? previous
          : {
              ...previous,
              edges: {
                ...previous.edges,
                [key]: { ...conditionFor(previous, picked.key, picked.edge) },
              },
            },
      );
    },
    [],
  );

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
            className="relative h-full w-full overflow-hidden rounded-lg border"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            {/* `activeView` is already "2d" whenever there is no solution, so
                the null check here only tells the compiler what the derivation
                guarantees. */}
            {activeView === "3d" && solution ? (
              <SurfaceCanvas
                solution={solution}
                mesh={mesh}
                boundary={boundary}
                holes={holes}
                showMesh={showMesh}
                zScale={zScale}
                stale={solutionIsStale}
              />
            ) : (
              <MeshCanvas
                boundary={boundary}
                holes={holes}
                draft={draft}
                cursor={cursor}
                mesh={mesh}
                solution={solution}
                showField={showField}
                fieldStale={solutionIsStale}
                // Drawing and condition-editing are mutually exclusive: a click
                // has to mean exactly one thing.
                edgePickEnabled={editingConditions && mode === "idle"}
                selectedEdge={selectedEdge}
                onEdgePick={handleEdgePick}
                minAngleDeg={minAngleDeg}
                showMesh={showMesh}
                stale={meshIsStale}
                selectedRange={selectedBucket}
                onCanvasClick={handleCanvasClick}
                onCursorMove={setCursor}
              />
            )}

            {/* Absolutely positioned so the canvas keeps the whole box: both
                views size themselves from the parent's client area. */}
            <div className="absolute top-2 right-2 flex gap-px">
              <ViewTab label="2D" active={activeView === "2d"} onClick={() => showView("2d")} />
              <ViewTab
                label="3D"
                active={activeView === "3d"}
                // Nothing solved means nothing to raise: the button says so
                // rather than switching to an empty box.
                disabled={!solution}
                title={solution ? undefined : "Solve first — 3D shows the field as height"}
                onClick={() => showView("3d")}
              />
            </div>

            {activeView === "3d" && (
              <p
                className="absolute bottom-2 left-2 text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Drag to orbit · scroll to zoom · double-click to reset
              </p>
            )}
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

          {/* --- boundary conditions --- */}
          {boundary && (
            <section className="space-y-2">
              <h2
                className="flex items-baseline justify-between text-xs font-semibold tracking-wide uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                <span>Boundary conditions</span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingConditions((previous) => !previous);
                    setSelectedEdge(null);
                  }}
                  className="normal-case underline"
                  style={{
                    color: editingConditions ? "var(--series-1)" : "var(--text-muted)",
                  }}
                >
                  {editingConditions ? "done" : "pick edges"}
                </button>
              </h2>

              {editingConditions && (
                <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Click an edge on the canvas to give it its own condition. Until
                  then every edge of a loop shares the loop&apos;s.
                </p>
              )}

              {loopEntries(boundary, holes).map(({ key, loop }) => {
                const overrides = Array.from({ length: loop.length }, (_, edge) => edge).filter(
                  (edge) => conditions.edges[`${key}:${edge}` as EdgeKey] !== undefined,
                );

                return (
                  <div key={key} className="space-y-1.5">
                    <ConditionRow
                      label={key === "boundary" ? "Outer boundary" : `Hole ${Number(key.split(":")[1]) + 1}`}
                      value={conditions.loops[key] ?? DEFAULT_CONDITION}
                      onChange={(next) => setLoopCondition(key, next)}
                    />
                    {overrides.map((edge) => {
                      const edgeKey = `${key}:${edge}` as EdgeKey;
                      return (
                        <ConditionRow
                          key={edgeKey}
                          label={`Edge ${edge + 1}`}
                          nested
                          highlighted={
                            selectedEdge?.key === key && selectedEdge.edge === edge
                          }
                          value={conditions.edges[edgeKey] ?? DEFAULT_CONDITION}
                          onChange={(next) => setEdgeCondition(edgeKey, next)}
                          onRemove={() => {
                            clearEdgeCondition(edgeKey);
                            if (selectedEdge?.key === key && selectedEdge.edge === edge) {
                              setSelectedEdge(null);
                            }
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </section>
          )}

          {/* --- solve --- */}
          {boundary && (
            <section className="space-y-3">
              <h2
                className="flex items-baseline justify-between text-xs font-semibold tracking-wide uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                <span>Solve</span>
                {solution && solutionIsStale && (
                  <button
                    type="button"
                    onClick={handleSolve}
                    disabled={!canSolve}
                    className="normal-case underline disabled:opacity-40"
                    style={{ color: "var(--status-warning)" }}
                  >
                    out of date — re-solve
                  </button>
                )}
              </h2>

              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Conductivity k"
                  value={conductivity}
                  min={1e-9}
                  onChange={setConductivity}
                />
                <NumberField label="Source s" value={sourceValue} onChange={setSourceValue} />
              </div>

              <label className="block">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    Polynomial degree
                  </span>
                  <span className="tabular text-xs font-medium">p = {degree}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={1}
                  value={degree}
                  onChange={(event) => setDegree(Number(event.target.value))}
                  className="mt-1 w-full accent-[var(--series-1)]"
                />
              </label>

              <button
                type="button"
                onClick={handleSolve}
                disabled={!canSolve}
                className="w-full rounded border px-2 py-1.5 text-xs transition-colors disabled:opacity-40"
                style={{
                  borderColor: canSolve ? "var(--series-1)" : "var(--border)",
                  color: canSolve ? "var(--series-1)" : "var(--text-muted)",
                }}
              >
                {solveStatus === "solving"
                  ? "Solving…"
                  : meshIsStale
                    ? "Waiting for the mesh…"
                    : "Solve"}
              </button>

              {solution && activeView === "2d" && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={showField}
                    onChange={(event) => setShowField(event.target.checked)}
                    className="accent-[var(--series-1)]"
                  />
                  <span style={{ color: "var(--text-secondary)" }}>Show field</span>
                </label>
              )}

              {/* In 3D the field *is* the surface, so there is nothing to hide;
                  what the reader needs instead is control over how tall it is. */}
              {solution && activeView === "3d" && (
                <label className="block">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                      Vertical exaggeration
                    </span>
                    <span className="tabular text-xs font-medium">
                      {exaggeration.toFixed(1)}×
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={4}
                    step={0.1}
                    value={exaggeration}
                    onChange={(event) => setExaggeration(Number(event.target.value))}
                    className="mt-1 w-full accent-[var(--series-1)]"
                  />
                  <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Height is scaled to fit the plan, so the vertical axis is not
                    to scale and carries no units. The legend has the numbers.
                  </p>
                </label>
              )}

              {solveError && (
                <div
                  className="rounded border p-2 text-xs"
                  style={{
                    borderColor: "var(--status-critical)",
                    color: "var(--status-critical)",
                  }}
                >
                  <strong>Solve failed.</strong> {solveError}
                </div>
              )}

              {solution && (
                <FieldLegend
                  solution={solution}
                  stale={solutionIsStale}
                  elapsedMs={solveElapsedMs}
                />
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
                label="Solution .vtk"
                disabled={!solution}
                onClick={() => solution && download("solution.vtk", toVtkField(solution))}
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

/** One side of the viewport's projection switch. */
function ViewTab({
  label,
  active,
  disabled,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className="rounded border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
      style={{
        background: active ? "var(--series-1)" : "var(--surface)",
        borderColor: active ? "var(--series-1)" : "var(--border)",
        color: active ? "var(--surface)" : "var(--text-muted)",
      }}
    >
      {label}
    </button>
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

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        step="any"
        onChange={(event) => {
          const next = Number(event.target.value);
          // A half-typed number briefly parses as NaN, which the solver would
          // reject; holding the last good value keeps the field editable.
          if (Number.isFinite(next)) onChange(next);
        }}
        className="tabular mt-0.5 w-full rounded border bg-transparent px-1.5 py-1 text-xs"
        style={{ borderColor: "var(--border)" }}
      />
    </label>
  );
}

/**
 * One boundary condition: which kind, and its data.
 *
 * The labels state the physics rather than the name of the mathematician. A
 * Neumann value here is the outward *flux* `J·n`, which for diffusion is
 * `-k du/dn` -- the opposite sign to the derivative, and the single easiest
 * thing to get backwards, because a sign error still converges beautifully to
 * the wrong answer.
 */
function ConditionRow({
  label,
  value,
  nested,
  highlighted,
  onChange,
  onRemove,
}: {
  label: string;
  value: ConditionValue;
  nested?: boolean;
  highlighted?: boolean;
  onChange: (next: ConditionValue) => void;
  onRemove?: () => void;
}) {
  const kinds: { kind: ConditionKind; label: string; hint: string }[] = [
    { kind: "dirichlet", label: "Fixed value", hint: "u =" },
    { kind: "neumann", label: "Fixed flux", hint: "J·n =" },
    { kind: "robin", label: "Convective", hint: "k du/dn + c·u =" },
  ];

  return (
    <div
      className={`rounded border p-1.5 ${nested ? "ml-3" : ""}`}
      style={{
        borderColor: highlighted ? "var(--series-1)" : "var(--border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium">{label}</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-[11px] underline"
            style={{ color: "var(--text-muted)" }}
          >
            remove
          </button>
        )}
      </div>

      <select
        value={value.kind}
        onChange={(event) =>
          onChange({ ...value, kind: event.target.value as ConditionKind })
        }
        className="mt-1 w-full rounded border bg-transparent px-1 py-0.5 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
      >
        {kinds.map((entry) => (
          <option key={entry.kind} value={entry.kind}>
            {entry.label}
          </option>
        ))}
      </select>

      <div className="mt-1 flex items-center gap-1.5">
        <span
          className="shrink-0 text-[11px] whitespace-nowrap"
          style={{ color: "var(--text-muted)" }}
        >
          {kinds.find((entry) => entry.kind === value.kind)?.hint}
        </span>
        <input
          type="number"
          step="any"
          value={value.value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange({ ...value, value: next });
          }}
          className="tabular min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs"
          style={{ borderColor: "var(--border)" }}
        />
      </div>

      {value.kind === "robin" && (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="shrink-0 text-[11px]" style={{ color: "var(--text-muted)" }}>
            c =
          </span>
          <input
            type="number"
            step="any"
            min={1e-9}
            value={value.coefficient}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange({ ...value, coefficient: next });
            }}
            className="tabular min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs"
            style={{
              // The solver refuses a non-positive coefficient, so say so here
              // rather than letting the request come back as an error.
              borderColor:
                value.coefficient > 0 ? "var(--border)" : "var(--status-critical)",
            }}
          />
        </div>
      )}
    </div>
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
