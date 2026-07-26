/// <reference lib="webworker" />
//
// Runs the Rust mesher off the main thread.
//
// Refinement is a synchronous loop that can take hundreds of milliseconds, so
// running it inline would freeze the canvas exactly while the user is dragging
// the quality slider -- which is the one interaction that has to stay smooth.

import init, { mesh } from "../wasm/fea_wasm.js";
import type { MeshResponse, WorkerRequest, WorkerResponse } from "../lib/mesh";

// The binary is loaded from a plain URL under public/ rather than imported, so
// this does not depend on how the bundler treats .wasm assets.
let ready: Promise<unknown> | null = null;

function ensureReady() {
  if (!ready) {
    ready = init({ module_or_path: "/fea_wasm_bg.wasm" });
  }
  return ready;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, request } = event.data;

  try {
    await ensureReady();

    const startedAt = performance.now();
    const result = mesh(request) as MeshResponse;
    const elapsedMs = performance.now() - startedAt;

    const response: WorkerResponse = { id, ok: true, result, elapsedMs };
    self.postMessage(response);
  } catch (error) {
    // Includes panics escaping from Rust, which arrive here as thrown values.
    // Reporting them keeps a bad input from silently leaving the UI spinning.
    const response: WorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
