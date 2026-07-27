import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  identity,
  lookAt,
  multiply,
  perspective,
  transformPoint,
  type Vec3,
} from "./mat4.ts";

function close(a: number, b: number, tolerance = 1e-5) {
  assert.ok(Math.abs(a - b) < tolerance, `expected ${a} to be within ${tolerance} of ${b}`);
}

describe("multiply", () => {
  it("leaves a matrix alone when multiplied by the identity", () => {
    const m = perspective(Math.PI / 4, 1.5, 1, 100);
    const product = multiply(identity(), m);
    for (let i = 0; i < 16; i++) close(product[i], m[i]);
  });

  it("applies the right operand first", () => {
    // A translation by (10, 0, 0) written column-major: the offset sits in the
    // last column, elements 12..14.
    const translate = identity();
    translate[12] = 10;

    const scale = identity();
    scale[0] = 2;

    // scale * translate should translate, then scale: (0,0,0) -> (10,0,0) -> (20,0,0).
    close(transformPoint(multiply(scale, translate), [0, 0, 0])[0], 20);
    // translate * scale scales first, so the translation is not scaled.
    close(transformPoint(multiply(translate, scale), [0, 0, 0])[0], 10);
  });
});

describe("lookAt", () => {
  const eye: Vec3 = [0, -10, 0];
  const view = lookAt(eye, [0, 0, 0], [0, 0, 1]);

  it("puts the target on the view axis at the eye distance", () => {
    const [x, y, z] = transformPoint(view, [0, 0, 0]);
    close(x, 0);
    close(y, 0);
    // Right-handed: the camera looks down its own -z, so what is in front has
    // a negative z in view space.
    close(z, -10);
  });

  it("puts the eye at the origin of view space", () => {
    const [x, y, z] = transformPoint(view, eye);
    close(x, 0);
    close(y, 0);
    close(z, 0);
  });

  it("maps the up vector to screen up", () => {
    // A point above the target must land above the target on screen.
    const [, aboveY] = transformPoint(view, [0, 0, 5]);
    const [, targetY] = transformPoint(view, [0, 0, 0]);
    assert.ok(aboveY > targetY, "world +z must be screen +y");
  });

  it("survives an up vector that is not orthogonal to the view direction", () => {
    const slanted = lookAt(eye, [0, 0, 0], [0, 0.5, 1]);
    for (let i = 0; i < 16; i++) assert.ok(Number.isFinite(slanted[i]));
    const [, aboveY] = transformPoint(slanted, [0, 0, 5]);
    assert.ok(aboveY > 0);
  });
});

describe("perspective", () => {
  const projection = perspective(Math.PI / 2, 1, 1, 100);

  it("maps the near and far planes to the clip depth range", () => {
    close(transformPoint(projection, [0, 0, -1])[2], -1);
    close(transformPoint(projection, [0, 0, -100])[2], 1);
  });

  it("shrinks things with distance", () => {
    const near = transformPoint(projection, [1, 0, -2])[0];
    const far = transformPoint(projection, [1, 0, -20])[0];
    assert.ok(Math.abs(far) < Math.abs(near), "further must be smaller");
  });

  it("widens the horizontal field of view with the aspect ratio", () => {
    const wide = perspective(Math.PI / 2, 2, 1, 100);
    // The same off-axis point takes less of the clip box on a wider viewport.
    assert.ok(
      Math.abs(transformPoint(wide, [1, 0, -2])[0]) <
        Math.abs(transformPoint(projection, [1, 0, -2])[0]),
    );
  });
});
