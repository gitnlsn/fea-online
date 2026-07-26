"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { meshRequestKey } from "../lib/mesh";
import type { MeshRequest, MeshResponse, WorkerResponse } from "../lib/mesh";

export { meshRequestKey };

export interface MesherState {
  status: "idle" | "meshing" | "ready" | "error";
  mesh: MeshResponse | null;
  error: string | null;
  elapsedMs: number;
  /**
   * The request that produced `mesh`, serialised.
   *
   * Callers compare this against the request they would send now. A mesh is
   * kept on screen while the next one computes -- clearing it would make the
   * canvas flicker on every slider step -- but that means the displayed mesh
   * can belong to geometry the user has already replaced. Without this key
   * there is no way to tell, and a perfectly good mesh of the *previous* shape
   * reads as a corrupt mesh of the current one.
   */
  meshKey: string | null;
}

const INITIAL: MesherState = {
  status: "idle",
  mesh: null,
  error: null,
  elapsedMs: 0,
  meshKey: null,
};


/**
 * Drives the mesher worker, keeping only the newest request's result.
 *
 * Dragging a slider fires many requests in quick succession. The mesher runs a
 * synchronous refinement loop with no way to interrupt it partway, so in-flight
 * work cannot actually be cancelled -- instead each request carries an id and
 * responses for anything other than the newest are discarded. That prevents a
 * slow earlier run from landing after a fast later one and showing the user a
 * mesh that does not match the controls.
 *
 * True mid-run cancellation would need the Rust loop to poll a shared flag via
 * SharedArrayBuffer, which requires cross-origin isolation headers. Not worth it
 * until mesh sizes make the stale work actually expensive.
 */
export function useMesher() {
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);
  const latestId = useRef(-1);
  const keyById = useRef<Map<number, string>>(new Map());
  const [state, setState] = useState<MesherState>(INITIAL);

  useEffect(() => {
    const worker = new Worker(new URL("../app/mesher.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const key = keyById.current.get(message.id) ?? null;
      keyById.current.delete(message.id);

      if (message.id !== latestId.current) return;

      if (message.ok) {
        setState({
          status: "ready",
          mesh: message.result,
          error: null,
          elapsedMs: message.elapsedMs,
          meshKey: key,
        });
      } else {
        setState((previous) => ({
          ...previous,
          status: "error",
          error: message.error,
          elapsedMs: 0,
        }));
      }
    };

    worker.onerror = (event) => {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: event.message || "the mesher worker failed to start",
        elapsedMs: 0,
      }));
    };

    return () => worker.terminate();
  }, []);

  const run = useCallback((request: MeshRequest) => {
    const worker = workerRef.current;
    if (!worker) return;

    const id = ++nextId.current;
    latestId.current = id;
    keyById.current.set(id, meshRequestKey(request));
    setState((previous) => ({ ...previous, status: "meshing", error: null }));
    worker.postMessage({ id, request });
  }, []);

  const clear = useCallback(() => {
    // Bumped so any in-flight response is treated as stale and dropped.
    latestId.current = ++nextId.current;
    setState(INITIAL);
  }, []);

  return { ...state, run, clear };
}
