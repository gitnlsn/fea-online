"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "../components/controls";
import { MeshCanvas, type EdgeRef } from "../components/MeshCanvas";
import { Panel } from "../components/Panel";
import { SurfaceCanvas } from "../components/SurfaceCanvas";
import { ExportPanel } from "../components/panels/ExportPanel";
import { GeometryPanel, type Mode } from "../components/panels/GeometryPanel";
import { MeshPanel } from "../components/panels/MeshPanel";
import { PhysicsPanel } from "../components/panels/PhysicsPanel";
import { SolvePanel } from "../components/panels/SolvePanel";
import { meshRequestKey, useMesher } from "../hooks/useMesher";
import { useSolver } from "../hooks/useSolver";
import { autoZScale } from "../lib/surface";
import { WORLD_SIZE } from "../lib/viewport";
import { loopCornerAngles, validateLoop, type Loop, type Point } from "../lib/mesh";
import {
  buildSolveGeometry,
  conditionFor,
  loopEntries,
  NO_CONDITIONS,
  reconcileConditions,
  solveRequestKey,
  subdivisionsFor,
  type BoundaryConditions,
  type ConditionValue,
  type EdgeKey,
  type LoopKey,
} from "../lib/solve";

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

/**
 * Which panels the sidebar opens with.
 *
 * The three that answer "what am I looking at" -- the drawing, the mesh, the
 * answer -- since those are what a reader checks without being asked. Physics
 * and export are opened deliberately, when there is something to state or
 * something to take away.
 */
const DEFAULT_PANELS: Record<string, boolean> = {
  geometry: true,
  mesh: true,
  physics: false,
  solve: true,
  export: false,
};

export default function Page() {
  const [boundary, setBoundary] = useState<Loop | null>(SAMPLE_BOUNDARY);
  const [holes, setHoles] = useState<Loop[]>([SAMPLE_HOLE]);
  const [draft, setDraft] = useState<Point[]>([]);
  const [mode, setMode] = useState<Mode>("idle");
  const [cursor, setCursor] = useState<Point | null>(null);

  const [minAngleDeg, setMinAngleDeg] = useState(25);
  const [maxAreaPercent, setMaxAreaPercent] = useState(1.0);
  const [showMesh, setShowMesh] = useState(true);
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

  const [openPanels, setOpenPanels] = useState(DEFAULT_PANELS);

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

  const togglePanel = useCallback((id: string) => {
    setOpenPanels((previous) => ({ ...previous, [id]: !previous[id] }));
  }, []);

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

  /**
   * The histogram range being highlighted, and the mesh it was picked against.
   *
   * Stored with its mesh so it can be resolved on read, like `conditions` and
   * `selectedEdge` above: a range picked against one mesh highlights nothing
   * meaningful in the next, and pairing the two is what makes that a fact about
   * the selection rather than a rule some handler has to remember to apply.
   */
  const [storedBucket, setStoredBucket] = useState<{
    meshKey: string;
    range: [number, number];
  } | null>(null);

  const selectedBucket =
    storedBucket && storedBucket.meshKey === meshKey ? storedBucket.range : null;

  const selectBucket = useCallback(
    (range: [number, number] | null) => {
      setStoredBucket(range && meshKey ? { meshKey, range } : null);
    },
    [meshKey],
  );

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
    () => (solution ? autoZScale(solution.min_value, solution.max_value) * exaggeration : 1),
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

  const clearEdgeCondition = useCallback(
    (key: EdgeKey, loop: LoopKey, edge: number) => {
      setConditions((previous) => {
        const edges = { ...previous.edges };
        delete edges[key];
        return { ...previous, edges };
      });
      setSelectedEdge((previous) =>
        previous?.key === loop && previous.edge === edge ? null : previous,
      );
    },
    [],
  );

  /**
   * Clicking an edge splits it out of its loop's group.
   *
   * The override is seeded from whatever the edge already resolves to, so
   * selecting an edge never changes the problem -- only what can be edited.
   */
  const handleEdgePick = useCallback((picked: EdgeRef) => {
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
  }, []);

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

  const startDrawing = useCallback((next: Mode) => {
    setDraft([]);
    setMode(next);
    if (next === "boundary") {
      setBoundary(null);
      setHoles([]);
    }
  }, []);

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
          {/* Pinned above the panels, and outside them. A warning that can be
              collapsed out of sight is a warning that will be missed. */}
          {geometryError && (
            <Alert tone="critical">
              <strong>Invalid geometry.</strong> {geometryError}
            </Alert>
          )}

          {error && !geometryError && (
            <Alert tone="critical">
              <strong>Meshing failed.</strong> {error}
            </Alert>
          )}

          {mesh?.terminated_early && (
            <Alert tone="warning">
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
            </Alert>
          )}

          <Panel
            id="geometry"
            title="Geometry"
            summary={holes.length > 0 ? `${holes.length} hole${holes.length === 1 ? "" : "s"}` : undefined}
            open={openPanels.geometry}
            onToggle={togglePanel}
          >
            <GeometryPanel
              mode={mode}
              boundary={boundary}
              holes={holes}
              sharpCorners={sharpCorners}
              onStartDrawing={startDrawing}
              onResetToSample={() => {
                setBoundary(SAMPLE_BOUNDARY);
                setHoles([SAMPLE_HOLE]);
                setDraft([]);
                setMode("idle");
              }}
              onClearHoles={() => setHoles([])}
            />
          </Panel>

          <Panel
            id="mesh"
            title="Mesh"
            summary={
              meshIsStale ? (
                <span style={{ color: "var(--status-warning)" }}>remeshing…</span>
              ) : mesh ? (
                `${mesh.triangle_count.toLocaleString()} elements`
              ) : undefined
            }
            open={openPanels.mesh}
            onToggle={togglePanel}
          >
            <MeshPanel
              minAngleDeg={minAngleDeg}
              onMinAngleChange={setMinAngleDeg}
              maxAreaPercent={maxAreaPercent}
              onMaxAreaChange={setMaxAreaPercent}
              showMesh={showMesh}
              onShowMeshChange={setShowMesh}
              mesh={mesh}
              stale={meshIsStale}
              meshing={status === "meshing"}
              elapsedMs={elapsedMs}
              belowTarget={belowTarget}
              selectedBucket={selectedBucket}
              selectedCount={selectedCount}
              onSelectBucket={selectBucket}
            />
          </Panel>

          {boundary && (
            <Panel
              id="physics"
              title="Physics"
              summary={`k=${conductivity} · s=${sourceValue} · p=${degree}`}
              open={openPanels.physics}
              onToggle={togglePanel}
            >
              <PhysicsPanel
                boundary={boundary}
                holes={holes}
                conditions={conditions}
                editingConditions={editingConditions}
                onToggleEditing={() => {
                  setEditingConditions((previous) => !previous);
                  setSelectedEdge(null);
                }}
                selectedEdge={selectedEdge}
                onLoopCondition={setLoopCondition}
                onEdgeCondition={setEdgeCondition}
                onClearEdgeCondition={clearEdgeCondition}
                conductivity={conductivity}
                onConductivityChange={setConductivity}
                sourceValue={sourceValue}
                onSourceChange={setSourceValue}
                degree={degree}
                onDegreeChange={setDegree}
              />
            </Panel>
          )}

          {boundary && (
            <Panel
              id="solve"
              title="Solve"
              summary={
                solution && solutionIsStale ? (
                  <button
                    type="button"
                    onClick={handleSolve}
                    disabled={!canSolve}
                    className="underline disabled:opacity-40"
                    style={{ color: "var(--status-warning)" }}
                  >
                    out of date — re-solve
                  </button>
                ) : solveStatus === "solving" ? (
                  "solving…"
                ) : undefined
              }
              open={openPanels.solve}
              onToggle={togglePanel}
            >
              <SolvePanel
                canSolve={canSolve}
                solving={solveStatus === "solving"}
                meshIsStale={meshIsStale}
                onSolve={handleSolve}
                solution={solution}
                solutionIsStale={solutionIsStale}
                solveError={solveError}
                elapsedMs={solveElapsedMs}
                planView={activeView === "2d"}
                showField={showField}
                onShowFieldChange={setShowField}
                exaggeration={exaggeration}
                onExaggerationChange={setExaggeration}
              />
            </Panel>
          )}

          <Panel id="export" title="Export" open={openPanels.export} onToggle={togglePanel}>
            <ExportPanel
              mesh={mesh}
              solution={solution}
              boundary={boundary}
              holes={holes}
              minAngleDeg={minAngleDeg}
              maxAreaPercent={maxAreaPercent}
              loadError={loadError}
              onLoadError={setLoadError}
              onLoad={(loaded) => {
                setBoundary(loaded.boundary);
                setHoles(loaded.holes);
                setMinAngleDeg(loaded.minAngleDeg);
                setMaxAreaPercent(loaded.maxAreaPercent);
                setDraft([]);
                setMode("idle");
              }}
            />
          </Panel>
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
