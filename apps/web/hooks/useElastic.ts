"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { elasticRequestKey } from "../lib/elastic";
import type {
  ElasticRequest,
  ElasticResponse,
  ElasticWorkerResponse,
} from "../lib/elastic";

export interface ElasticState {
  status: "idle" | "solving" | "ready" | "error";
  solution: ElasticResponse | null;
  error: string | null;
  elapsedMs: number;
  /**
   * The problem that produced `solution`, serialised.
   *
   * Callers compare this against the problem they would send now. A result is
   * kept on screen after the supports or the mesh move on -- clearing it would
   * make the canvas flash empty every time a number is typed -- but that means
   * the deformed shape showing can belong to a part the user has already
   * changed, and a correct answer to the previous question looks exactly like a
   * wrong answer to this one.
   */
  solutionKey: string | null;
}

const INITIAL: ElasticState = {
  status: "idle",
  solution: null,
  error: null,
  elapsedMs: 0,
  solutionKey: null,
};

/**
 * Drives the elasticity worker, keeping only the newest request's result.
 *
 * The same id-based newest-wins discipline as `useSolver`, and no debounce for
 * the same reason: solving is a button, not a slider.
 *
 * One difference from the diffusion hook, and it is why `error` survives into
 * the `error` state rather than being logged. The elastic path *refuses*
 * problems the diffusion path would happily answer -- a part nothing is holding,
 * a material too close to incompressible -- and those refusals carry the only
 * explanation the user will get of why there is no picture. They are the normal
 * case, not an exception.
 */
export function useElastic() {
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);
  const latestId = useRef(-1);
  const keyById = useRef<Map<number, string>>(new Map());
  const [state, setState] = useState<ElasticState>(INITIAL);

  useEffect(() => {
    const worker = new Worker(new URL("../app/elastic.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<ElasticWorkerResponse>) => {
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
        error: event.message || "the elasticity worker failed to start",
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
  const run = useCallback((request: ElasticRequest, meshKey: string) => {
    const worker = workerRef.current;
    if (!worker) return;

    const id = ++nextId.current;
    latestId.current = id;
    keyById.current.set(id, elasticRequestKey(request, meshKey));
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
