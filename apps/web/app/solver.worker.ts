/// <reference lib="webworker" />
//
// Runs the Rust discontinuous Galerkin solver off the main thread.
//
// Separate from the mesher's worker rather than sharing it. A worker handles
// messages one at a time, and neither the refinement loop nor conjugate
// gradient can be interrupted partway, so a multi-second solve queued in front
// of a remesh would freeze the quality slider -- the exact interaction the
// mesher worker exists to keep smooth. The cost is one more wasm instance, not
// a second compile: both workers fetch the same binary and the browser caches
// the compiled module.

import init, { solve } from "../wasm/fea_wasm.js";
import type {
  SolveResponse,
  SolverWorkerRequest,
  SolverWorkerResponse,
} from "../lib/solve";

// The binary is loaded from a plain URL under public/ rather than imported, so
// this does not depend on how the bundler treats .wasm assets.
let ready: Promise<unknown> | null = null;

function ensureReady() {
  if (!ready) {
    ready = init({ module_or_path: "/fea_wasm_bg.wasm" });
  }
  return ready;
}

self.onmessage = async (event: MessageEvent<SolverWorkerRequest>) => {
  const { id, request } = event.data;

  try {
    await ensureReady();

    const startedAt = performance.now();
    const result = solve(request) as SolveResponse;
    const elapsedMs = performance.now() - startedAt;

    const response: SolverWorkerResponse = { id, ok: true, result, elapsedMs };
    self.postMessage(response);
  } catch (error) {
    // Includes panics escaping from Rust, which arrive here as thrown values.
    // The solver validates its input precisely so that this path stays empty in
    // normal use -- a panic would have aborted the instance, not just this call.
    const response: SolverWorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
