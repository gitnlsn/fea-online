/// <reference lib="webworker" />
//
// Runs the transient Euler solver off the main thread, a frame at a time.
//
// Its own worker rather than sharing the steady solver's. A worker handles one
// message at a time and a transient run is the longest thing this app does --
// seconds to a minute -- so sharing would mean a steady solve queued behind an
// animation, and, worse, no way to interrupt the animation to run one.
//
// The frame loop yields to the event queue between frames. That is what makes
// cancellation work at all: the Rust stepping inside one frame cannot be
// interrupted, but the gap between two frames is a point where a `cancel`
// message can be delivered. Frames are therefore also the granularity at which
// the run can be stopped, which is why a frame is a fraction of a second of
// work rather than the whole run.

import init, { TransientRun } from "../wasm/fea_wasm.js";
import type {
  TransientProgress,
  TransientSetup,
  TransientWorkerRequest,
  TransientWorkerResponse,
} from "../lib/transient";

let ready: Promise<unknown> | null = null;

function ensureReady() {
  if (!ready) {
    ready = init({ module_or_path: "/fea_wasm_bg.wasm" });
  }
  return ready;
}

/** The run in flight, if any. Only ever one. */
let current: { id: number; run: TransientRun } | null = null;

function post(message: TransientWorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

/** Lets the event queue run, so a queued `cancel` is delivered. */
function yieldToQueue() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function cancel() {
  if (current) {
    // Dropping the Rust object frees the mesh, the state and every buffer. The
    // wasm-bindgen wrapper needs the explicit call; there is no destructor on
    // the JavaScript side.
    current.run.free();
    current = null;
  }
}

async function start(id: number, request: TransientWorkerRequest & { kind: "start" }) {
  await ensureReady();
  cancel();

  const run = new TransientRun(request.request);
  current = { id, run };

  const setup = run.setup() as TransientSetup;
  const positions = run.positions();
  const vectorOrigins = run.vector_origins();
  post({ id, kind: "setup", setup, positions, vectorOrigins }, [
    positions.buffer,
    vectorOrigins.buffer,
  ]);

  const startedAt = performance.now();

  for (let index = 0; index < setup.frames; index++) {
    // Between every frame, not only at the end: a run that has been superseded
    // should stop stepping rather than finish and be thrown away.
    if (!current || current.id !== id) return;

    const values = run.advance() as Float32Array | null;
    if (values === null) break;

    const progress = run.progress() as TransientProgress;
    let min = Infinity;
    let max = -Infinity;
    for (let at = 0; at < values.length; at++) {
      const value = values[at];
      if (value < min) min = value;
      if (value > max) max = value;
    }

    // Velocity is a second payload, not a component of the first: it is a
    // vector at one point per element, where the scalar is a number at every
    // point of the display lattice. The two have different lengths and
    // different meanings and are drawn by different code.
    const vectors = run.vectors();
    let fastest = 0;
    for (let at = 0; at + 1 < vectors.length; at += 2) {
      const speed = Math.hypot(vectors[at], vectors[at + 1]);
      if (speed > fastest) fastest = speed;
    }

    post(
      {
        id,
        kind: "frame",
        frame: { index, time: progress.time, values, vectors, min, max, fastest },
        progress,
      },
      [values.buffer, vectors.buffer],
    );

    await yieldToQueue();
  }

  if (!current || current.id !== id) return;

  post({
    id,
    kind: "done",
    progress: run.progress() as TransientProgress,
    elapsedMs: performance.now() - startedAt,
  });
  cancel();
}

self.onmessage = async (event: MessageEvent<TransientWorkerRequest>) => {
  const message = event.data;

  if (message.kind === "cancel") {
    cancel();
    return;
  }

  try {
    await start(message.id, message);
  } catch (error) {
    cancel();
    // Includes anything thrown out of Rust. `validate` exists precisely so that
    // a bad request lands here as a message rather than as a panic, which would
    // have aborted the wasm instance and left this worker permanently unable to
    // run anything.
    post({
      id: message.id,
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
