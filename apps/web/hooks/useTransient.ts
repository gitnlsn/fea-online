"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { rangeOver, transientRequestKey } from "../lib/transient";
import type {
  TransientFrame,
  TransientProgress,
  TransientRequest,
  TransientSetup,
  TransientWorkerResponse,
} from "../lib/transient";

export interface TransientState {
  status: "idle" | "running" | "ready" | "error";
  setup: TransientSetup | null;
  positions: Float32Array | null;
  /** Where the velocity arrows are anchored: one point per element. */
  vectorOrigins: Float32Array | null;
  frames: TransientFrame[];
  progress: TransientProgress | null;
  error: string | null;
  elapsedMs: number;
  /**
   * The problem that produced these frames, serialised.
   *
   * Same discipline as `useSolver`: the animation stays on screen after the
   * geometry or the conditions move on, because clearing it would empty the
   * viewport on every keystroke -- so this is the only way to tell a correct
   * answer to the previous question from a wrong answer to this one.
   */
  runKey: string | null;
  /** The colour range over every frame collected. */
  range: { min: number; max: number };
}

const INITIAL: TransientState = {
  status: "idle",
  setup: null,
  positions: null,
  vectorOrigins: null,
  frames: [],
  progress: null,
  error: null,
  elapsedMs: 0,
  runKey: null,
  range: { min: 0, max: 1 },
};

/**
 * Drives the transient worker, collecting frames as they arrive.
 *
 * Frames accumulate rather than replacing one another, because the point of the
 * run is to scrub back and forth through it afterwards. That is also why the
 * range is recomputed as they land: the colour scale has to span the whole run,
 * and the whole run is not known until it finishes. Frames already drawn are
 * redrawn against the widened range, which is why an animation's colours settle
 * over the first second and then stop moving.
 */
export function useTransient() {
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);
  const latestId = useRef(-1);
  const keyById = useRef<Map<number, string>>(new Map());
  const [state, setState] = useState<TransientState>(INITIAL);

  useEffect(() => {
    const worker = new Worker(new URL("../app/transient.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<TransientWorkerResponse>) => {
      const message = event.data;
      if (message.id !== latestId.current) return;

      switch (message.kind) {
        case "setup":
          setState((previous) => ({
            ...previous,
            status: "running",
            setup: message.setup,
            positions: message.positions,
            vectorOrigins: message.vectorOrigins,
            frames: [],
            error: null,
            runKey: keyById.current.get(message.id) ?? null,
          }));
          break;

        case "frame":
          setState((previous) => {
            const frames = [...previous.frames, message.frame];
            return { ...previous, frames, progress: message.progress, range: rangeOver(frames) };
          });
          break;

        case "done":
          keyById.current.delete(message.id);
          setState((previous) => ({
            ...previous,
            status: "ready",
            progress: message.progress,
            elapsedMs: message.elapsedMs,
          }));
          break;

        case "error":
          keyById.current.delete(message.id);
          setState((previous) => ({
            ...previous,
            // Frames already collected are kept: a run that goes unstable
            // halfway is far more informative watched up to the point it failed
            // than replaced by a message.
            status: "error",
            error: message.error,
          }));
          break;
      }
    };

    worker.onerror = (event) => {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: event.message || "the transient worker failed to start",
      }));
    };

    return () => worker.terminate();
  }, []);

  const run = useCallback((request: TransientRequest, meshKey: string) => {
    const worker = workerRef.current;
    if (!worker) return;

    const id = ++nextId.current;
    latestId.current = id;
    keyById.current.set(id, transientRequestKey(request, meshKey));
    setState((previous) => ({ ...previous, status: "running", error: null, frames: [] }));
    worker.postMessage({ id, kind: "start", request });
  }, []);

  const cancel = useCallback(() => {
    const worker = workerRef.current;
    // Bumped first, so anything already in flight is treated as stale on
    // arrival even if the cancel is delivered between two frames.
    latestId.current = ++nextId.current;
    worker?.postMessage({ id: latestId.current, kind: "cancel" });
    setState((previous) => ({
      ...previous,
      status: previous.frames.length > 0 ? "ready" : "idle",
    }));
  }, []);

  const clear = useCallback(() => {
    latestId.current = ++nextId.current;
    workerRef.current?.postMessage({ id: latestId.current, kind: "cancel" });
    setState(INITIAL);
  }, []);

  return { ...state, run, cancel, clear };
}
