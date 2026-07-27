/**
 * The camera for the 3D view, as plain data.
 *
 * Kept out of the component for the same reason `viewport.ts` is kept out of
 * `MeshCanvas`: the transitions are the part with rules in them -- what clamps,
 * what wraps, how far a pixel of drag turns the scene -- and rules are worth
 * testing without a canvas.
 *
 * The camera orbits a fixed target rather than flying freely. There is exactly
 * one thing to look at, and a free camera's main talent is getting lost.
 */

import { lookAt, multiply, perspective, type Mat4, type Vec3 } from "./mat4.ts";
import { WORLD_SIZE } from "./viewport.ts";

export interface Camera {
  /** Rotation about the vertical axis, in radians. */
  azimuth: number;
  /** Angle above the ground plane, in radians. Clamped away from the poles. */
  elevation: number;
  /** Distance from the target, in world units. */
  distance: number;
}

/**
 * What the camera orbits: the centre of the world box, at a given height.
 *
 * The height is a parameter rather than zero because the surface is not on the
 * ground -- it floats at whatever the exaggeration puts it. Orbiting the ground
 * would send the picture off the top of the frame the moment the slider moves,
 * and make every zoom pull toward a point nobody is looking at. Aiming at the
 * middle of the drawn relief keeps the surface centred at any exaggeration.
 */
export function target(height = 0): Vec3 {
  return [WORLD_SIZE / 2, WORLD_SIZE / 2, height];
}

/**
 * A three-quarter view from above.
 *
 * Not straight down -- an overhead view is the 2D view with extra steps, and the
 * whole point of arriving in 3D is to see relief immediately. Not from the side
 * either, which hides the plan. Roughly 35 degrees up reads both at once.
 */
export const DEFAULT_CAMERA: Camera = {
  azimuth: -Math.PI / 2.4,
  elevation: 0.62,
  distance: WORLD_SIZE * 1.9,
};

/**
 * How close to straight up or down the camera may get.
 *
 * At exactly the pole the view direction is parallel to `up` and the view basis
 * collapses, so the picture snaps to an arbitrary rotation. Stopping just short
 * costs a view nobody wants and removes the failure entirely.
 */
const POLE_LIMIT = Math.PI / 2 - 0.01;

/** Radians of rotation per pixel of drag. A full turn is about 500 px. */
const RADIANS_PER_PIXEL = 0.012;

const MIN_DISTANCE = WORLD_SIZE * 0.25;
const MAX_DISTANCE = WORLD_SIZE * 8;

/** Where the eye sits, given the orbit about a target at `height`. */
export function cameraPosition(camera: Camera, height = 0): Vec3 {
  const at = target(height);
  const horizontal = Math.cos(camera.elevation) * camera.distance;

  return [
    at[0] + horizontal * Math.cos(camera.azimuth),
    at[1] + horizontal * Math.sin(camera.azimuth),
    at[2] + Math.sin(camera.elevation) * camera.distance,
  ];
}

/**
 * The camera after a drag of `dx`, `dy` screen pixels.
 *
 * Dragging right spins the scene right, and dragging down tips the camera up and
 * over -- the grab-the-object convention, so the point under the cursor moves
 * the way the cursor does.
 */
export function orbit(camera: Camera, dx: number, dy: number): Camera {
  return {
    ...camera,
    azimuth: camera.azimuth - dx * RADIANS_PER_PIXEL,
    elevation: clamp(camera.elevation + dy * RADIANS_PER_PIXEL, -POLE_LIMIT, POLE_LIMIT),
  };
}

/**
 * The camera after a wheel notch.
 *
 * Multiplicative, so a notch covers the same *fraction* of the remaining
 * distance whether you are far out or close in. A fixed step would crawl from
 * far away and slam into the target up close.
 */
export function dolly(camera: Camera, deltaY: number): Camera {
  return {
    ...camera,
    distance: clamp(
      camera.distance * Math.exp(deltaY * 0.001),
      MIN_DISTANCE,
      MAX_DISTANCE,
    ),
  };
}

/**
 * The combined projection-view matrix for a viewport of this size.
 *
 * `up` is +z: the solution is the vertical axis here, so "up" on screen means
 * "more field", which is the only reading that makes the picture mean anything.
 */
export function viewProjection(
  camera: Camera,
  width: number,
  height: number,
  targetHeight = 0,
): Mat4 {
  const aspect = height > 0 ? width / height : 1;
  const projection = perspective(Math.PI / 4, aspect, 1, MAX_DISTANCE * 4);
  const view = lookAt(
    cameraPosition(camera, targetHeight),
    target(targetHeight),
    [0, 0, 1],
  );

  return multiply(projection, view);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
