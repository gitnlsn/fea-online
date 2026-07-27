"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { solveRequestKey } from "../lib/solve";
import type { SolveRequest, SolveResponse, SolverWorkerResponse } from "../lib/solve";

export interface SolverState {
  status: "idle" | "solving" | "ready" | "error";
  solution: SolveResponse | null;
  error: string | null;
  elapsedMs: number;
  /**
   * The problem that produced `solution`, serialised.
   *
   * Callers compare this against the problem they would send now. A field is
   * kept on screen after the conditions or the mesh move on -- clearing it
   * would make the canvas flash empty every time a number is typed -- but that
   * means the field showing can belong to a problem the user has already
   * changed. Without this key there is no way to tell, and a correct answer to
   * the *previous* question is indistinguishable from a wrong answer to this
   * one.
   */
  solutionKey: string | null;
}

const INITIAL: SolverState = {
  status: "idle",
  solution: null,
  error: null,
  elapsedMs: 0,
  solutionKey: null,
};

/**
 * Drives the solver worker, keeping only the newest request's result.
 *
 * The same id-based discipline as `useMesher`, and for the same reason:
 * conjugate gradient runs as a synchronous loop with no way to interrupt it, so
 * in-flight work cannot be cancelled. Each request carries an id and anything
 * other than the newest is discarded on arrival, which stops a slow earlier
 * solve from landing after a fast later one and showing a field that does not
 * match the conditions on screen.
 *
 * Unlike the mesher there is no debounce, because solving is triggered by a
 * button rather than by a slider -- there is nothing to coalesce. Solving is
 * explicit precisely because it is not in the mesher's cost class: the operator's
 * condition number grows like p^4/h^2, so a fine high-order mesh legitimately
 * needs thousands of iterations, and no debounce interval makes that feel live.
 */
export function useSolver() {
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);
  const latestId = useRef(-1);
  const keyById = useRef<Map<number, string>>(new Map());
  const [state, setState] = useState<SolverState>(INITIAL);

  useEffect(() => {
    const worker = new Worker(new URL("../app/solver.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<SolverWorkerResponse>) => {
      const message = event.data;
      const key = keyById.current.get(message.id) ?? null;
      keyById.current.delete(message.id);

      if (message.id !== latestId.current) return;

      if (message.ok) {
        setState({
          status: "ready",
          solution: message.result,
          error: null,
          elapsedMs: message.elapsedMs,
          solutionKey: key,
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
        error: event.message || "the solver worker failed to start",
        elapsedMs: 0,
      }));
    };

    return () => worker.terminate();
  }, []);

  /**
   * `meshKey` travels alongside the request rather than being derived from it:
   * the stored key has to identify which mesh was solved on, and the vertex and
   * triangle arrays are far too large to hash on every call.
   */
  const run = useCallback((request: SolveRequest, meshKey: string) => {
    const worker = workerRef.current;
    if (!worker) return;

    const id = ++nextId.current;
    latestId.current = id;
    keyById.current.set(id, solveRequestKey(request, meshKey));
    setState((previous) => ({ ...previous, status: "solving", error: null }));
    worker.postMessage({ id, request });
  }, []);

  const clear = useCallback(() => {
    // Bumped so any in-flight response is treated as stale and dropped.
    latestId.current = ++nextId.current;
    setState(INITIAL);
  }, []);

  return { ...state, run, clear };
}
