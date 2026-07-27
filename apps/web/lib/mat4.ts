/**
 * The 4x4 matrix maths the 3D view needs, and nothing else.
 *
 * Column-major throughout, which is the layout `gl.uniformMatrix4fv` expects
 * with `transpose = false` -- the only layout WebGL2 accepts. Element `[c * 4 +
 * r]` is row `r` of column `c`, so the translation of a transform sits in
 * elements 12, 13, 14 rather than 3, 7, 11.
 *
 * Written here rather than pulled in because this is the whole of it: two
 * matrices to build and one product to take. A matrix library would be more
 * code to install than to own.
 */

/** A column-major 4x4, ready to hand to `uniformMatrix4fv`. */
export type Mat4 = Float32Array;

export type Vec3 = readonly [number, number, number];

export function identity(): Mat4 {
  // prettier-ignore
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * Right-handed perspective projection onto the clip volume WebGL uses.
 *
 * `near` and `far` are distances in front of the eye, both positive. The depth
 * range is the OpenGL convention of -1 at the near plane to +1 at the far one,
 * which is what `gl.depthRange` defaults to.
 */
export function perspective(
  fovyRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovyRadians / 2);
  const depth = 1 / (near - far);

  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0,                     0,
    0,          f, 0,                     0,
    0,          0, (far + near) * depth,  -1,
    0,          0, 2 * far * near * depth, 0,
  ]);
}

/**
 * View matrix for an eye at `eye` looking at `center`.
 *
 * `up` only has to be non-parallel to the view direction; it is re-orthogonalised
 * against it. Keeping the camera off the pole is the caller's job -- see the
 * elevation clamp in `orbit.ts` -- because exactly parallel is the one case this
 * cannot recover from.
 */
export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const forward = normalize([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
  const side = normalize(cross(forward, up));
  // Re-derived from the two axes already fixed, so a slanted `up` cannot skew
  // the basis.
  const trueUp = cross(side, forward);

  // prettier-ignore
  return new Float32Array([
    side[0], trueUp[0], -forward[0], 0,
    side[1], trueUp[1], -forward[1], 0,
    side[2], trueUp[2], -forward[2], 0,
    -dot(side, eye), -dot(trueUp, eye), dot(forward, eye), 1,
  ]);
}

/** The product `a * b`: the transform that applies `b` first, then `a`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);

  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }

  return out;
}

/** Applies a transform to a point, dividing through by w. */
export function transformPoint(m: Mat4, p: Vec3): [number, number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];

  return w === 0 ? [x, y, z] : [x / w, y / w, z / w];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
}
