/// <reference lib="webworker" />
//
// Runs the Rust linear elasticity solver off the main thread.
//
// Its own worker rather than a second message type on the diffusion one, for
// the reason that split the mesher from the solver in the first place: a worker
// handles messages one at a time, and conjugate gradient cannot be interrupted
// partway. The cost is one more wasm instance, not a second compile -- every
// worker fetches the same binary and the browser caches the compiled module.

import init, { solve_elastic } from "../wasm/fea_wasm.js";
import type {
  ElasticResponse,
  ElasticWorkerRequest,
  ElasticWorkerResponse,
} from "../lib/elastic";

// The binary is loaded from a plain URL under public/ rather than imported, so
// this does not depend on how the bundler treats .wasm assets.
let ready: Promise<unknown> | null = null;

function ensureReady() {
  if (!ready) {
    ready = init({ module_or_path: "/fea_wasm_bg.wasm" });
  }
  return ready;
}

self.onmessage = async (event: MessageEvent<ElasticWorkerRequest>) => {
  const { id, request } = event.data;

  try {
    await ensureReady();

    const startedAt = performance.now();
    const result = solve_elastic(request) as ElasticResponse;
    const elapsedMs = performance.now() - startedAt;

    const response: ElasticWorkerResponse = { id, ok: true, result, elapsedMs };
    self.postMessage(response);
  } catch (error) {
    // Two very different things arrive here. A refusal -- an unsupported part, a
    // material outside the range -- is an ordinary error carrying a message
    // written for the user, and is the common case. A panic escaping Rust would
    // also land here, but it would already have aborted the wasm instance; the
    // solver validates its input precisely so that path stays empty.
    const response: ElasticWorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
