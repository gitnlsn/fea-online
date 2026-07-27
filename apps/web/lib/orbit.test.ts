import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cameraPosition,
  DEFAULT_CAMERA,
  dolly,
  orbit,
  target,
  viewProjection,
} from "./orbit.ts";
import { transformPoint } from "./mat4.ts";
import { WORLD_SIZE } from "./viewport.ts";

describe("cameraPosition", () => {
  it("sits at the orbit distance from the target", () => {
    for (const height of [0, 30, -12]) {
      const eye = cameraPosition(DEFAULT_CAMERA, height);
      const at = target(height);
      const distance = Math.hypot(eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]);
      assert.ok(Math.abs(distance - DEFAULT_CAMERA.distance) < 1e-9);
    }
  });

  it("opens above the ground plane", () => {
    assert.ok(cameraPosition(DEFAULT_CAMERA)[2] > 0, "the default view looks down");
  });

  it("rises with the target it is aimed at", () => {
    const low = cameraPosition(DEFAULT_CAMERA, 0);
    const high = cameraPosition(DEFAULT_CAMERA, 50);
    // Raising the target lifts the whole orbit by the same amount, leaving the
    // view direction untouched.
    assert.ok(Math.abs(high[2] - low[2] - 50) < 1e-9);
    assert.ok(Math.abs(high[0] - low[0]) < 1e-9);
  });
});

describe("orbit", () => {
  it("turns the scene the way the pointer moves", () => {
    const dragged = orbit(DEFAULT_CAMERA, 50, 0);
    assert.ok(dragged.azimuth < DEFAULT_CAMERA.azimuth);
  });

  it("clamps elevation short of the poles", () => {
    const up = orbit(DEFAULT_CAMERA, 0, -100_000);
    const down = orbit(DEFAULT_CAMERA, 0, 100_000);

    assert.ok(Math.abs(up.elevation) < Math.PI / 2);
    assert.ok(Math.abs(down.elevation) < Math.PI / 2);
    // Still off the pole by enough that the view basis does not collapse: the
    // horizontal radius must stay meaningfully non-zero.
    assert.ok(Math.cos(up.elevation) > 1e-3);
    assert.ok(Math.cos(down.elevation) > 1e-3);
  });

  it("leaves the distance alone", () => {
    assert.equal(orbit(DEFAULT_CAMERA, 30, 20).distance, DEFAULT_CAMERA.distance);
  });
});

describe("dolly", () => {
  it("moves in and out", () => {
    assert.ok(dolly(DEFAULT_CAMERA, -100).distance < DEFAULT_CAMERA.distance);
    assert.ok(dolly(DEFAULT_CAMERA, 100).distance > DEFAULT_CAMERA.distance);
  });

  it("never reaches the target or leaves the scene", () => {
    let camera = DEFAULT_CAMERA;
    for (let i = 0; i < 200; i++) camera = dolly(camera, -200);
    assert.ok(camera.distance > 0);

    camera = DEFAULT_CAMERA;
    for (let i = 0; i < 200; i++) camera = dolly(camera, 200);
    assert.ok(camera.distance <= WORLD_SIZE * 8);
  });

  it("covers the same fraction per notch at any distance", () => {
    const near = { ...DEFAULT_CAMERA, distance: 40 };
    const far = { ...DEFAULT_CAMERA, distance: 400 };
    const ratio = (camera: typeof near) => dolly(camera, 100).distance / camera.distance;
    assert.ok(Math.abs(ratio(near) - ratio(far)) < 1e-9);
  });
});

describe("viewProjection", () => {
  it("keeps the world box on screen from the default camera", () => {
    const mvp = viewProjection(DEFAULT_CAMERA, 900, 600);

    for (const corner of [
      [0, 0, 0],
      [WORLD_SIZE, 0, 0],
      [0, WORLD_SIZE, 0],
      [WORLD_SIZE, WORLD_SIZE, 0],
    ] as const) {
      const [x, y, z] = transformPoint(mvp, corner);
      assert.ok(Math.abs(x) <= 1, `corner ${corner} off screen in x: ${x}`);
      assert.ok(Math.abs(y) <= 1, `corner ${corner} off screen in y: ${y}`);
      assert.ok(z > -1 && z < 1, `corner ${corner} outside the depth range: ${z}`);
    }
  });

  it("puts nearer geometry at a smaller depth", () => {
    const mvp = viewProjection(DEFAULT_CAMERA, 900, 600);
    const eyeSide = transformPoint(mvp, [WORLD_SIZE / 2, WORLD_SIZE / 2, 40])[2];
    const groundSide = transformPoint(mvp, [WORLD_SIZE / 2, WORLD_SIZE / 2, 0])[2];
    // The default camera looks down, so a raised point is nearer.
    assert.ok(eyeSide < groundSide);
  });

  it("keeps a raised surface framed by aiming at it", () => {
    // The case the target height exists for: relief tall enough to leave the
    // frame entirely when the camera is aimed at the ground.
    const peak = 120;
    const aimed = viewProjection(DEFAULT_CAMERA, 900, 600, peak / 2);
    const grounded = viewProjection(DEFAULT_CAMERA, 900, 600, 0);

    const top: [number, number, number] = [WORLD_SIZE / 2, WORLD_SIZE / 2, peak];
    assert.ok(Math.abs(transformPoint(aimed, top)[1]) <= 1, "peak off screen when aimed");
    assert.ok(
      Math.abs(transformPoint(grounded, top)[1]) >
        Math.abs(transformPoint(aimed, top)[1]),
      "aiming at the relief must frame it better than aiming at the ground",
    );
  });
});
