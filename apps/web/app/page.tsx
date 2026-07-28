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
import { GasPanel } from "../components/panels/GasPanel";
import { GasBoundaryPanel } from "../components/panels/GasBoundaryPanel";
import { RunPanel } from "../components/panels/RunPanel";
import { StudySwitch, type Study } from "../components/StudySwitch";
import { TimeSlider } from "../components/TimeSlider";
import { meshRequestKey, useMesher } from "../hooks/useMesher";
import { useSolver } from "../hooks/useSolver";
import { usePlayback } from "../hooks/usePlayback";
import { useTransient } from "../hooks/useTransient";
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
  type DrawableField,
  type LoopKey,
} from "../lib/solve";
import {
  blastInitial,
  buildTransientGeometry,
  frameField,
  gasConditionFor,
  GAS_CONDITION_TONES,
  NO_GAS_CONDITIONS,
  reconcileGasConditions,
  transientRequestKey,
  type GasConditions,
  type GasConditionValue,
  type TransientSettings,
} from "../lib/transient";

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
  gas: true,
  boundaries: true,
  run: true,
  export: false,
};

/**
 * A blast in the middle of the world box, at ten times ambient.
 *
 * Ten is chosen to be visibly a shock while staying comfortably inside what the
 * scheme handles without the positivity limiter having to work hard, so the
 * default run looks right rather than being a stress test.
 */
const DEFAULT_TRANSIENT: TransientSettings = {
  initial: blastInitial([WORLD_SIZE / 2, WORLD_SIZE / 2], WORLD_SIZE / 10, 10),
  // Long enough for the wave to cross the sample domain, reflect off the walls
  // and pile up in the corners. A shorter run finishes sooner and shows only the
  // blast expanding, which is the least interesting part and not what the panel
  // says it does.
  endTime: 30,
  frames: 60,
  degree: 1,
  cfl: 0.3,
  limiter: 0,
  field: "density",
  showVectors: true,
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
  /**
   * Which study's boundary conditions are being picked, if either.
   *
   * A discriminant rather than two booleans, because `MeshCanvas` takes exactly
   * one `selectedEdge`/`onEdgePick` pair and a click has to mean exactly one
   * thing. Two flags could both be true; this cannot.
   */
  const [editing, setEditing] = useState<null | "steady" | "gas">(null);
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

  const [study, setStudy] = useState<Study>("steady");
  const [transient, setTransient] = useState<TransientSettings>(DEFAULT_TRANSIENT);
  const [storedGasConditions, setGasConditions] = useState<GasConditions>(NO_GAS_CONDITIONS);

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
  const {
    status: transientStatus,
    setup: transientSetup,
    positions: transientPositions,
    vectorOrigins: transientVectorOrigins,
    frames: transientFrames,
    progress: transientProgress,
    error: transientError,
    elapsedMs: transientElapsedMs,
    runKey: transientKey,
    range: transientRange,
    run: runTransient,
    cancel: cancelTransient,
    clear: clearTransient,
  } = useTransient();
  const playback = usePlayback(transientFrames.length);
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

  /**
   * Gas conditions as they apply to the geometry currently drawn.
   *
   * Same reconcile-on-read discipline as `conditions`: editors write to the
   * stored value, everything that reads a condition reads this, so the two
   * cannot disagree for even one render.
   */
  const gasConditions = useMemo(
    () => reconcileGasConditions(boundary, holes, storedGasConditions),
    [boundary, holes, storedGasConditions],
  );

  /** The transient problem as currently stated, or null when there is none. */
  const transientRequest = useMemo(() => {
    if (!mesh || !boundary || geometryError) return null;

    return {
      vertices: mesh.vertices,
      triangles: mesh.triangles,
      ...buildTransientGeometry(boundary, holes, gasConditions),
      initial: transient.initial,
      gamma: 1.4,
      degree: transient.degree,
      end_time: transient.endTime,
      frames: transient.frames,
      cfl: transient.cfl,
      limiter: transient.limiter,
      // Held below the steady path's, because the cost is paid once per frame
      // rather than once per solve and nobody reads curvature off a moving
      // surface.
      subdivisions: Math.min(2, subdivisionsFor(transient.degree)),
      field: transient.field,
    };
  }, [mesh, boundary, holes, geometryError, transient, gasConditions]);

  const transientIsStale = useMemo(() => {
    if (!transientKey || !transientRequest || !meshKey) return false;
    return transientKey !== transientRequestKey(transientRequest, meshKey);
  }, [transientKey, transientRequest, meshKey]);

  useEffect(() => {
    if (!boundary) clearTransient();
  }, [boundary, clearTransient]);

  const canRunTransient =
    transientRequest !== null &&
    !meshIsStale &&
    transientStatus !== "running" &&
    !geometryError;

  const handleRunTransient = useCallback(() => {
    if (!transientRequest || !meshKey) return;
    setStudy("transient");
    playback.seek(0);
    runTransient(transientRequest, meshKey);
  }, [transientRequest, meshKey, runTransient, playback]);

  /**
   * The frame currently on screen, presented as something drawable.
   *
   * Both viewports take a `DrawableField`, so a transient frame and a steady
   * solution go down exactly the same path -- which is what guarantees the two
   * studies are drawn by the same code and cannot disagree about what a field
   * looks like.
   */
  const transientFrame = useMemo(() => {
    if (!transientSetup || !transientPositions || transientFrames.length === 0) return null;
    const frame = transientFrames[Math.min(playback.frame, transientFrames.length - 1)];
    return frameField(transientSetup, transientPositions, frame, transientRange);
  }, [transientSetup, transientPositions, transientFrames, playback.frame, transientRange]);

  /** What the viewport draws, whichever study is showing. */
  const shownField: DrawableField | null =
    study === "transient" ? transientFrame : solution;
  const shownIsStale = study === "transient" ? transientIsStale : solutionIsStale;
  const shownTime =
    study === "transient" && transientFrames.length > 0
      ? transientFrames[Math.min(playback.frame, transientFrames.length - 1)].time
      : 0;

  const canSolve =
    solveRequest !== null && !meshIsStale && solveStatus !== "solving" && !geometryError;

  /** World units of height per unit of field, as the 3D view draws it. */
  const zScale = useMemo(
    () => (shownField ? autoZScale(shownField.min_value, shownField.max_value) * exaggeration : 1),
    [shownField, exaggeration],
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
  const activeView: View = shownField ? view : "2d";

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
      setEditing(null);
      setSelectedEdge(null);
    }
  }, []);

  const handleSolve = useCallback(() => {
    if (!solveRequest || !meshKey) return;
    // Pressing Solve is a statement about what you want to look at, not only
    // about what you want computed: leaving an animation on screen while the
    // steady field arrives behind it would be the surprising thing.
    setStudy("steady");
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

  const setGasLoopCondition = useCallback((key: LoopKey, next: GasConditionValue) => {
    setGasConditions((previous) => ({
      ...previous,
      loops: { ...previous.loops, [key]: next },
    }));
  }, []);

  const setGasEdgeCondition = useCallback((key: EdgeKey, next: GasConditionValue) => {
    setGasConditions((previous) => ({
      ...previous,
      edges: { ...previous.edges, [key]: next },
    }));
  }, []);

  const clearGasEdgeCondition = useCallback(
    (key: EdgeKey, loop: LoopKey, edge: number) => {
      setGasConditions((previous) => {
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
  const handleEdgePick = useCallback(
    (picked: EdgeRef) => {
      setSelectedEdge(picked);
      const key = `${picked.key}:${picked.edge}` as EdgeKey;

      // The click belongs to whichever study asked for it, and exactly one can
      // have done so.
      if (editing === "gas") {
        setGasConditions((previous) =>
          previous.edges[key]
            ? previous
            : {
                ...previous,
                edges: {
                  ...previous.edges,
                  [key]: { ...gasConditionFor(previous, picked.key, picked.edge) },
                },
              },
        );
        return;
      }

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
    [editing],
  );

  /**
   * How each boundary edge is stroked while the gas study is showing.
   *
   * Read from the CSS custom properties at draw time, since a canvas cannot use
   * them directly. Only supplied in the Air study — in Diffusion the drawing
   * keeps its uniform outline.
   */
  const gasEdgeTone = useCallback(
    (loop: LoopKey, edge: number) => {
      const tone = GAS_CONDITION_TONES[gasConditionFor(gasConditions, loop, edge).kind];
      const styles = getComputedStyle(document.documentElement);
      return {
        color: styles.getPropertyValue(tone.token).trim() || "#888",
        dash: tone.dash,
        width: tone.width,
      };
    },
    [gasConditions],
  );

  /** The velocity field of the frame on screen, when arrows are asked for. */
  const shownVectors = useMemo(() => {
    if (study !== "transient" || !transient.showVectors) return null;
    if (!transientVectorOrigins || transientFrames.length === 0) return null;
    const frame = transientFrames[Math.min(playback.frame, transientFrames.length - 1)];
    return { origins: transientVectorOrigins, values: frame.vectors, fastest: frame.fastest };
  }, [study, transient.showVectors, transientVectorOrigins, transientFrames, playback.frame]);

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
            {activeView === "3d" && shownField ? (
              <SurfaceCanvas
                solution={shownField}
                mesh={mesh}
                boundary={boundary}
                holes={holes}
                // Element outlines on a moving surface are noise, and drawing
                // them doubles the per-frame buffer work for it.
                showMesh={showMesh && !playback.playing}
                zScale={zScale}
                stale={shownIsStale}
              />
            ) : (
              <MeshCanvas
                boundary={boundary}
                holes={holes}
                draft={draft}
                cursor={cursor}
                mesh={mesh}
                solution={shownField}
                edgeTone={study === "transient" ? gasEdgeTone : undefined}
                vectors={shownVectors}
                showField={showField}
                fieldStale={shownIsStale}
                // Drawing and condition-editing are mutually exclusive: a click
                // has to mean exactly one thing.
                edgePickEnabled={editing !== null && mode === "idle"}
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
                disabled={!shownField}
                title={shownField ? undefined : "Solve first — 3D shows the field as height"}
                onClick={() => showView("3d")}
              />
            </div>

            {study === "transient" && transientFrames.length > 0 && (
              <TimeSlider
                playback={playback}
                frames={transientFrames.length}
                total={transient.frames}
                time={shownTime}
                endTime={transient.endTime}
              />
            )}

            {activeView === "3d" && study !== "transient" && (
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
          <StudySwitch
            study={study}
            onChange={(next) => {
              setStudy(next);
              // Editing belongs to a study, so it does not survive leaving one:
              // a pick made in Air must not land in Poisson's conditions.
              setEditing(null);
              setSelectedEdge(null);
            }}
          />

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

          {study === "steady" && boundary && (
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
                editingConditions={editing === "steady"}
                onToggleEditing={() => {
                  setEditing((previous) => (previous === "steady" ? null : "steady"));
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

          {study === "steady" && boundary && (
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

          {study === "transient" && (
            <>
              <Panel
                id="gas"
                title="Gas"
                summary={
                  transient.initial.kind === "blast"
                    ? `blast ×${transient.initial.inside.pressure}`
                    : transient.initial.kind === "riemann"
                      ? "shock tube"
                      : "still air"
                }
                open={openPanels.gas}
                onToggle={togglePanel}
              >
                <GasPanel settings={transient} onChange={setTransient} world={WORLD_SIZE} />
              </Panel>

              {boundary && (
                <Panel
                  id="boundaries"
                  title="Boundaries"
                  summary={
                    Object.keys(gasConditions.edges).length > 0
                      ? `${Object.keys(gasConditions.edges).length} edge overrides`
                      : undefined
                  }
                  open={openPanels.boundaries}
                  onToggle={togglePanel}
                >
                  <GasBoundaryPanel
                    boundary={boundary}
                    holes={holes}
                    conditions={gasConditions}
                    editing={editing === "gas"}
                    onToggleEditing={() => {
                      setEditing((previous) => (previous === "gas" ? null : "gas"));
                      setSelectedEdge(null);
                      setMode("idle");
                      setDraft([]);
                    }}
                    selectedEdge={selectedEdge}
                    onLoopCondition={setGasLoopCondition}
                    onEdgeCondition={setGasEdgeCondition}
                    onClearEdgeCondition={clearGasEdgeCondition}
                  />
                </Panel>
              )}

              <Panel
                id="run"
                title="Run"
                summary={
                  transientStatus === "running"
                    ? `frame ${transientFrames.length}/${transient.frames}`
                    : transientFrames.length > 0 && transientIsStale
                      ? "out of date"
                      : undefined
                }
                open={openPanels.run}
                onToggle={togglePanel}
              >
                <RunPanel
                  settings={transient}
                  onChange={setTransient}
                  status={transientStatus}
                  progress={transientProgress}
                  frameCount={transientFrames.length}
                  elapsedMs={transientElapsedMs}
                  error={transientError}
                  stale={transientIsStale}
                  canRun={canRunTransient}
                  onRun={handleRunTransient}
                  onCancel={cancelTransient}
                />
              </Panel>
            </>
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
