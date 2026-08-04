"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DIVERGING_COOL,
  DIVERGING_WARM,
  FIELD_RAMP,
  fieldScale,
  rgbTriplet,
} from "../lib/fieldRamp";
import type { Loop, MeshResponse } from "../lib/mesh";
import type { DrawableField } from "../lib/solve";
import { DEFAULT_CAMERA, dolly, orbit, viewProjection, type Camera } from "../lib/orbit";
import {
  buildElementOutlines,
  buildOutlineDisplacements,
  buildPlanGrid,
  buildPlanOutline,
  buildPlanWireframe,
  buildSurface,
  buildSurfaceDisplacements,
} from "../lib/surface";

/**
 * The solution as a surface over the plan.
 *
 * The 2D view answers "where is the field high"; this one answers "by how
 * much", which a colour ramp can only ever approximate. It also makes the
 * discontinuities legible: a jump between elements that reads as two adjacent
 * shades of orange in plan is a visible step here, and watching those steps
 * close as the degree rises is the clearest picture of convergence the tool can
 * give.
 *
 * WebGL2 rather than the 2D context the rest of the app draws with. A field at a
 * few thousand elements is tens of thousands of sub-triangles, and orbiting means
 * repainting all of them per frame -- an order of magnitude past what filling
 * paths one at a time can do, whatever the transform.
 */

const SURFACE_VERTEX = `#version 300 es
in vec3 aPosition;
// The in-plane displacement, for a study that has one. Attribute 1 is left
// disabled otherwise, which makes WebGL supply the constant set by
// vertexAttrib3f -- so this reads zero rather than reading nothing.
in vec3 aWarp;

uniform mat4 uMvp;
uniform float uZScale;
uniform float uWarp;

out float vValue;
out vec3 vWorld;

void main() {
  // z arrives as the raw field value and xy as the undeformed plan; both
  // exaggerations are applied here so that moving either slider is a uniform
  // update rather than a buffer rebuild.
  vValue = aPosition.z;
  vWorld = vec3(aPosition.xy + uWarp * aWarp.xy, aPosition.z * uZScale);
  gl_Position = uMvp * vec4(vWorld, 1.0);
}`;

const SURFACE_FRAGMENT = `#version 300 es
precision highp float;

in float vValue;
in vec3 vWorld;

out vec4 outColor;

uniform vec3 uSequential[7];
uniform vec3 uCool[6];
uniform vec3 uWarm[6];
uniform vec3 uNeutral;
uniform vec3 uBackground;

uniform bool uDiverging;
uniform float uMin;
uniform float uMax;
uniform float uExtent;
uniform float uDim;

/* Mirrors step() in lib/fieldRamp.ts: the fraction floored into the ramp's own
   length, clamped at both ends. Same arithmetic, so the surface, the 2D fill and
   the legend all land on the same stop for the same value. */
int stepIndex(float fraction, int length) {
  return clamp(int(floor(fraction * float(length))), 0, length - 1);
}

vec3 rampColor() {
  if (uDiverging) {
    /* A field that came out exactly flat has no extent to normalise against. */
    if (uExtent <= 0.0) return uNeutral;

    /* Each arm is [neutral, ...six stops] -- seven entries with the neutral
       first, matching how fieldColor builds it. */
    int index = stepIndex(min(1.0, abs(vValue) / uExtent), 7);
    if (index == 0) return uNeutral;
    return vValue < 0.0 ? uCool[index - 1] : uWarm[index - 1];
  }

  float span = uMax - uMin;
  if (span <= 0.0) return uSequential[3];
  return uSequential[stepIndex((vValue - uMin) / span, 7)];
}

void main() {
  vec3 color = rampColor();

  /* Flat normals from the screen-space derivatives of the world position. The
     surface is a triangle soup with no normal attribute, and the two derivatives
     span exactly the plane of the face -- so shading costs nothing but this
     cross product, and stays flat per sub-triangle, which is honest about the
     resolution actually being drawn. */
  vec3 face = cross(dFdx(vWorld), dFdy(vWorld));
  float area = length(face);
  /* abs(), because the underside of a surface is worth seeing too. */
  float lambert = area > 0.0
    ? abs(dot(face / area, normalize(vec3(0.35, -0.5, 0.85))))
    : 1.0;

  /* Kept to a narrow band: enough relief to read the form, not enough to be
     mistaken for a change in the value. */
  vec3 shaded = color * (0.80 + 0.20 * lambert);

  /* Staleness fades toward the background rather than lowering alpha. A
     half-transparent surface drawn unsorted would show through itself, which
     reads as a defect in the solution rather than as a note about it. */
  outColor = vec4(mix(shaded, uBackground, uDim), 1.0);
}`;

const LINE_VERTEX = `#version 300 es
in vec3 aPosition;
in vec3 aWarp;

uniform mat4 uMvp;
uniform float uZScale;
uniform float uWarp;

void main() {
  gl_Position = uMvp * vec4(aPosition.xy + uWarp * aWarp.xy, aPosition.z * uZScale, 1.0);
}`;

const LINE_FRAGMENT = `#version 300 es
precision highp float;

out vec4 outColor;

uniform vec3 uColor;
uniform vec3 uBackground;
uniform float uDim;

void main() {
  outColor = vec4(mix(uColor, uBackground, uDim), 1.0);
}`;

interface SurfaceProgram {
  program: WebGLProgram;
  uniform: Record<string, WebGLUniformLocation | null>;
}

interface Resources {
  gl: WebGL2RenderingContext;
  vao: WebGLVertexArrayObject;
  surface: SurfaceProgram;
  line: SurfaceProgram;
  buffers: Record<BufferName, WebGLBuffer>;
  /** Vertices held in each buffer; zero means there is nothing to draw. */
  counts: Record<BufferName, number>;
}

type BufferName =
  | "surface"
  | "outlines"
  | "wireframe"
  | "plan"
  | "grid"
  | "surfaceWarp"
  | "outlinesWarp";

const BUFFER_NAMES: BufferName[] = [
  "surface",
  "outlines",
  "wireframe",
  "plan",
  "grid",
  "surfaceWarp",
  "outlinesWarp",
];

interface SurfaceCanvasProps {
  solution: DrawableField;
  mesh: MeshResponse | null;
  boundary: Loop | null;
  holes: Loop[];
  /** Draws the mesh, both as the plan underneath and as element borders on top. */
  showMesh: boolean;
  /** World units of height per unit of field. See `autoZScale`. */
  zScale: number;
  /**
   * How far to exaggerate the field's in-plane displacement. See
   * `autoWarpScale`.
   *
   * Has no effect unless the field carries displacements, which is only the
   * solid study -- and when it does not, the attribute stays disabled and reads
   * a constant zero, so the arithmetic is identical to what it was before this
   * existed.
   */
  warp?: number;
  /** The field answers a problem that has since changed. */
  stale: boolean;
}

export function SurfaceCanvas({
  solution,
  mesh,
  boundary,
  holes,
  showMesh,
  zScale,
  warp = 0,
  stale,
}: SurfaceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resourcesRef = useRef<Resources | null>(null);

  /**
   * The camera, held in a ref rather than in state.
   *
   * Orbiting fires at pointer rate, and a re-render per event would rebuild
   * every prop-derived value in this component to change one matrix. The draw is
   * imperative anyway, so nothing React renders depends on where the camera is.
   */
  const cameraRef = useRef<Camera>(DEFAULT_CAMERA);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const [unsupported, setUnsupported] = useState(false);

  const draw = useCallback(() => {
    const resources = resourcesRef.current;
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!resources || !canvas || !parent) return;

    const { gl } = resources;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(parent.clientWidth * ratio));
    const height = Math.max(1, Math.round(parent.clientHeight * ratio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${parent.clientWidth}px`;
      canvas.style.height = `${parent.clientHeight}px`;
    }

    gl.viewport(0, 0, width, height);

    // Resolved per draw rather than cached: these follow the theme, and the
    // theme can change under a mounted canvas.
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) =>
      rgbTriplet(styles.getPropertyValue(name).trim() || fallback);

    const background = token("--surface", "#fcfcfb");
    const neutral = token("--div-mid", "#f0efec");
    const gridline = token("--gridline", "#e1e0d9");
    const baseline = token("--baseline", "#c3c2b7");
    const muted = token("--text-muted", "#898781");

    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const scale = fieldScale(solution.min_value, solution.max_value);
    // Aimed at the middle of the drawn relief, so raising the exaggeration grows
    // the surface about the centre of the frame instead of lifting it out of it.
    const centre = ((solution.min_value + solution.max_value) / 2) * zScale;
    const mvp = viewProjection(cameraRef.current, width, height, centre);
    const dim = stale ? 0.55 : 0;

    gl.bindVertexArray(resources.vao);

    /**
     * Points attribute 1 at a displacement buffer, or -- when there is none --
     * disables it and leaves WebGL supplying a constant zero.
     *
     * The constant is what keeps every study but the solid bit-identical to
     * what it drew before displacements existed: `aWarp` reads (0,0,0) and the
     * added term vanishes exactly rather than approximately.
     */
    const bindWarp = (name: BufferName | null) => {
      if (name && resources.counts[name] > 0) {
        gl.enableVertexAttribArray(1);
        gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffers[name]);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(1);
        gl.vertexAttrib3f(1, 0, 0, 0);
      }
    };

    const drawLines = (name: BufferName, color: number[], warpBuffer: BufferName | null) => {
      const count = resources.counts[name];
      if (count === 0) return;

      bindWarp(warpBuffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffers[name]);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.uniform3fv(resources.line.uniform.uColor, color);
      gl.drawArrays(gl.LINES, 0, count);
    };

    // --- the plan, flat on the ground ---
    gl.useProgram(resources.line.program);
    gl.uniformMatrix4fv(resources.line.uniform.uMvp, false, mvp);
    gl.uniform1f(resources.line.uniform.uZScale, zScale);
    gl.uniform1f(resources.line.uniform.uWarp, warp);
    gl.uniform3fv(resources.line.uniform.uBackground, background);
    gl.uniform1f(resources.line.uniform.uDim, 0);

    // The plan is what was *drawn*, so it stays undeformed even when the
    // surface above it moves -- that contrast is the point of having both.
    drawLines("grid", gridline, null);
    if (showMesh) drawLines("wireframe", gridline, null);
    drawLines("plan", baseline, null);

    // --- the solution, above it ---
    gl.useProgram(resources.surface.program);
    gl.uniformMatrix4fv(resources.surface.uniform.uMvp, false, mvp);
    gl.uniform1f(resources.surface.uniform.uZScale, zScale);
    gl.uniform1f(resources.surface.uniform.uWarp, warp);
    gl.uniform3fv(resources.surface.uniform.uNeutral, neutral);
    gl.uniform3fv(resources.surface.uniform.uBackground, background);
    gl.uniform1i(resources.surface.uniform.uDiverging, scale.kind === "diverging" ? 1 : 0);
    gl.uniform1f(resources.surface.uniform.uMin, scale.min);
    gl.uniform1f(resources.surface.uniform.uMax, scale.max);
    gl.uniform1f(resources.surface.uniform.uExtent, scale.kind === "diverging" ? scale.extent : 0);
    gl.uniform1f(resources.surface.uniform.uDim, dim);

    if (resources.counts.surface > 0) {
      bindWarp("surfaceWarp");
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffers.surface);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      // Pushes the fill back a hair in depth so the element borders drawn next
      // sit on it cleanly instead of z-fighting along their whole length.
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, resources.counts.surface);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    // --- element borders, lifted onto the surface ---
    if (showMesh) {
      gl.useProgram(resources.line.program);
      gl.uniform1f(resources.line.uniform.uDim, dim);
      drawLines("outlines", muted, "outlinesWarp");
    }

    gl.bindVertexArray(null);
  }, [solution, showMesh, zScale, warp, stale]);

  // --- one-time GL setup ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // `antialias` matters more here than usual: the element borders are
    // one-pixel lines at arbitrary angles, and aliased they read as a dashed
    // mesh rather than a solid one.
    const gl = canvas.getContext("webgl2", { antialias: true, depth: true });
    if (!gl) {
      setUnsupported(true);
      return;
    }

    const surface = createProgram(gl, SURFACE_VERTEX, SURFACE_FRAGMENT, [
      "uMvp",
      "uZScale",
      "uWarp",
      "uSequential",
      "uCool",
      "uWarm",
      "uNeutral",
      "uBackground",
      "uDiverging",
      "uMin",
      "uMax",
      "uExtent",
      "uDim",
    ]);
    const line = createProgram(gl, LINE_VERTEX, LINE_FRAGMENT, [
      "uMvp",
      "uZScale",
      "uWarp",
      "uColor",
      "uBackground",
      "uDim",
    ]);

    if (!surface || !line) {
      setUnsupported(true);
      return;
    }

    // The ramps never change, so they are uploaded once rather than per draw.
    gl.useProgram(surface.program);
    gl.uniform3fv(surface.uniform.uSequential, flatten(FIELD_RAMP));
    gl.uniform3fv(surface.uniform.uCool, flatten(DIVERGING_COOL));
    gl.uniform3fv(surface.uniform.uWarm, flatten(DIVERGING_WARM));

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    // Both programs bind position to location 0, so one enabled attribute
    // serves every draw and only the bound buffer changes.
    gl.enableVertexAttribArray(0);
    // Location 1 is the displacement, and is enabled per draw rather than here:
    // most draws have none, and a disabled attribute reads the constant below.
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib3f(1, 0, 0, 0);
    gl.bindVertexArray(null);

    const buffers = {} as Record<BufferName, WebGLBuffer>;
    const counts = {} as Record<BufferName, number>;
    for (const name of BUFFER_NAMES) {
      buffers[name] = gl.createBuffer();
      counts[name] = 0;
    }

    gl.enable(gl.DEPTH_TEST);
    // Culling stays off: the underside of a surface is a legitimate thing to
    // want to look at, and a solution has no inside.
    gl.disable(gl.CULL_FACE);

    resourcesRef.current = { gl, vao, surface, line, buffers, counts };

    // The grid is the world box and never changes.
    upload(gl, buffers.grid, buildPlanGrid(), counts, "grid");

    return () => {
      for (const name of BUFFER_NAMES) gl.deleteBuffer(buffers[name]);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(surface.program);
      gl.deleteProgram(line.program);
      resourcesRef.current = null;
    };
  }, []);

  // --- buffers, rebuilt only when what they describe changes ---
  useEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;

    const { gl, buffers, counts } = resources;
    upload(gl, buffers.surface, buildSurface(solution), counts, "surface");
    upload(gl, buffers.outlines, buildElementOutlines(solution), counts, "outlines");
    // Empty for a field with no displacement, which leaves the counts at zero
    // and so leaves `bindWarp` taking the constant path.
    upload(
      gl,
      buffers.surfaceWarp,
      buildSurfaceDisplacements(solution) ?? new Float32Array(0),
      counts,
      "surfaceWarp",
    );
    upload(
      gl,
      buffers.outlinesWarp,
      buildOutlineDisplacements(solution) ?? new Float32Array(0),
      counts,
      "outlinesWarp",
    );
  }, [solution]);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;

    const { gl, buffers, counts } = resources;
    upload(
      gl,
      buffers.wireframe,
      mesh ? buildPlanWireframe(mesh) : new Float32Array(0),
      counts,
      "wireframe",
    );
  }, [mesh]);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;

    const { gl, buffers, counts } = resources;
    upload(gl, buffers.plan, buildPlanOutline(boundary, holes), counts, "plan");
  }, [boundary, holes]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    const parent = canvasRef.current?.parentElement;
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, [draw]);

  /**
   * Zooming is wired up by hand because it has to be able to cancel the page
   * scroll, and React attaches wheel listeners passively -- where
   * `preventDefault` is ignored and the sidebar scrolls instead.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current = dolly(cameraRef.current, event.deltaY);
      draw();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [draw]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const from = dragRef.current;
    if (!from) return;

    cameraRef.current = orbit(
      cameraRef.current,
      event.clientX - from.x,
      event.clientY - from.y,
    );
    dragRef.current = { x: event.clientX, y: event.clientY };
    draw();
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  if (unsupported) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <p className="max-w-xs text-center text-xs" style={{ color: "var(--text-secondary)" }}>
          This browser has no WebGL2 context, so the surface cannot be drawn.
          The 2D view shows the same field as a colour map.
        </p>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        cameraRef.current = DEFAULT_CAMERA;
        draw();
      }}
      className="block h-full w-full touch-none cursor-grab active:cursor-grabbing"
    />
  );
}

/** The ramp as the flat `vec3[]` a uniform array upload expects. */
function flatten(ramp: readonly string[]): Float32Array {
  return new Float32Array(ramp.flatMap((color) => rgbTriplet(color)));
}

function upload(
  gl: WebGL2RenderingContext,
  buffer: WebGLBuffer,
  data: Float32Array,
  counts: Record<BufferName, number>,
  name: BufferName,
) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  counts[name] = data.length / 3;
}

/**
 * Compiles and links a program, returning it alongside its uniform locations.
 *
 * Returns null rather than throwing on failure. A shader that will not compile
 * is a bug, but it is one the whole page should survive: the 2D view still shows
 * the field, and taking the app down with it would hide the very thing the user
 * was looking at.
 */
function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  uniforms: string[],
): SurfaceProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  // Bound before linking so both programs agree on the attribute locations,
  // which is what lets one vertex array object serve every draw.
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.bindAttribLocation(program, 1, "aWarp");
  gl.linkProgram(program);

  // The shaders are linked into the program and are not needed again.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("surface program failed to link:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  const uniform: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniforms) uniform[name] = gl.getUniformLocation(program, name);

  return { program, uniform };
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("shader failed to compile:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}
