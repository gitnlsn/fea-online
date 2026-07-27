import type { Loop, MeshResponse } from "./mesh";
import type { SolveResponse } from "./solve";

/**
 * Gmsh ASCII mesh, format 2.2.
 *
 * 2.2 rather than the newer 4.1 because it is what most solvers and readers
 * (FEniCS/meshio/Elmer, and every tutorial) accept without argument, and this
 * mesh has no entity hierarchy that 4.1 would express better.
 *
 * Node and element numbering is 1-based, which is what trips people converting
 * from the 0-based index buffer.
 */
export function toGmsh(mesh: MeshResponse): string {
  const lines: string[] = [
    "$MeshFormat",
    "2.2 0 8",
    "$EndMeshFormat",
    "$Nodes",
    String(mesh.vertex_count),
  ];

  for (let i = 0; i < mesh.vertex_count; i++) {
    // Gmsh nodes are always 3D; a planar mesh pins z to 0.
    lines.push(`${i + 1} ${mesh.vertices[i * 2]} ${mesh.vertices[i * 2 + 1]} 0`);
  }

  lines.push("$EndNodes", "$Elements", String(mesh.triangle_count));

  for (let e = 0; e < mesh.triangle_count; e++) {
    const a = mesh.triangles[e * 3] + 1;
    const b = mesh.triangles[e * 3 + 1] + 1;
    const c = mesh.triangles[e * 3 + 2] + 1;
    // "2" is the 3-node triangle type; "2 0 1" is two tags, both placeholder
    // physical/geometrical ids until boundary groups exist.
    lines.push(`${e + 1} 2 2 0 1 ${a} ${b} ${c}`);
  }

  lines.push("$EndElements", "");
  return lines.join("\n");
}

/**
 * Legacy VTK, for ParaView.
 *
 * Carries the per-element minimum angle as cell data, so the quality field can
 * be inspected outside this tool rather than only in the histogram here.
 */
export function toVtk(mesh: MeshResponse): string {
  const lines: string[] = [
    "# vtk DataFile Version 3.0",
    "fea-online mesh",
    "ASCII",
    "DATASET UNSTRUCTURED_GRID",
    `POINTS ${mesh.vertex_count} double`,
  ];

  for (let i = 0; i < mesh.vertex_count; i++) {
    lines.push(`${mesh.vertices[i * 2]} ${mesh.vertices[i * 2 + 1]} 0`);
  }

  // Each cell line is "<count> <ids...>", so the size field counts that leading
  // count too -- 4 entries per triangle, not 3.
  lines.push("", `CELLS ${mesh.triangle_count} ${mesh.triangle_count * 4}`);
  for (let e = 0; e < mesh.triangle_count; e++) {
    lines.push(
      `3 ${mesh.triangles[e * 3]} ${mesh.triangles[e * 3 + 1]} ${mesh.triangles[e * 3 + 2]}`,
    );
  }

  lines.push("", `CELL_TYPES ${mesh.triangle_count}`);
  for (let e = 0; e < mesh.triangle_count; e++) lines.push("5");

  lines.push(
    "",
    `CELL_DATA ${mesh.triangle_count}`,
    "SCALARS min_angle_deg double 1",
    "LOOKUP_TABLE default",
  );
  for (const angle of mesh.min_angles_deg) lines.push(String(angle));

  lines.push("");
  return lines.join("\n");
}

/**
 * Legacy VTK carrying the solved field, for ParaView.
 *
 * Written as its own dataset rather than as point data on the exported mesh,
 * because a discontinuous Galerkin solution has no single value at a shared
 * node -- neighbouring elements legitimately disagree there, and that
 * disagreement is a measure of how converged the answer is. Attaching the field
 * to the mesh's own points would force an average across elements, quietly
 * smoothing away the one thing the method is distinctive for.
 *
 * So the sampled lattice goes out verbatim: every element brings its own copy
 * of every point, duplicated along shared edges. ParaView renders that as-is,
 * jumps included.
 */
export function toVtkField(field: SolveResponse): string {
  const points = field.element_count * field.sample_stride;
  const perElement = field.sub_triangles.length / 3;
  const cells = field.element_count * perElement;

  const lines: string[] = [
    "# vtk DataFile Version 3.0",
    `fea-online solution, degree ${field.degree}`,
    "ASCII",
    "DATASET UNSTRUCTURED_GRID",
    `POINTS ${points} double`,
  ];

  for (let i = 0; i < points; i++) {
    lines.push(`${field.positions[i * 2]} ${field.positions[i * 2 + 1]} 0`);
  }

  // The sub-triangle list is stored once in element-local indices, so writing it
  // out means offsetting by each element's base.
  lines.push("", `CELLS ${cells} ${cells * 4}`);
  for (let element = 0; element < field.element_count; element++) {
    const base = element * field.sample_stride;
    for (let corner = 0; corner < field.sub_triangles.length; corner += 3) {
      lines.push(
        `3 ${base + field.sub_triangles[corner]} ${base + field.sub_triangles[corner + 1]} ${
          base + field.sub_triangles[corner + 2]
        }`,
      );
    }
  }

  lines.push("", `CELL_TYPES ${cells}`);
  for (let i = 0; i < cells; i++) lines.push("5");

  lines.push("", `POINT_DATA ${points}`, "SCALARS u double 1", "LOOKUP_TABLE default");
  for (const value of field.values) lines.push(String(value));

  lines.push("");
  return lines.join("\n");
}

export interface GeometryDocument {
  version: 1;
  boundary: Loop | null;
  holes: Loop[];
  minAngleDeg: number;
  maxAreaPercent: number;
}

export function toGeometryJson(document: GeometryDocument): string {
  return JSON.stringify(document, null, 2);
}

/**
 * Parses a saved geometry document.
 *
 * Returns a reason rather than throwing, because this is fed by a file the user
 * picked and a bad pick should be a message, not a blank screen.
 */
export function parseGeometryJson(text: string): GeometryDocument | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "That file is not valid JSON.";
  }

  // Arrays are objects in JavaScript, so `typeof` alone lets a bare JSON array
  // through and it silently parses as an empty document.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "That file does not contain a geometry document.";
  }

  const candidate = parsed as Partial<GeometryDocument>;
  const isLoop = (value: unknown): value is Loop =>
    Array.isArray(value) &&
    value.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every((n) => typeof n === "number" && Number.isFinite(n)),
    );

  if (candidate.boundary != null && !isLoop(candidate.boundary)) {
    return "The boundary in that file is not a list of [x, y] points.";
  }
  if (candidate.holes != null && !(Array.isArray(candidate.holes) && candidate.holes.every(isLoop))) {
    return "The holes in that file are not lists of [x, y] points.";
  }

  return {
    version: 1,
    boundary: candidate.boundary ?? null,
    holes: candidate.holes ?? [],
    minAngleDeg:
      typeof candidate.minAngleDeg === "number" ? candidate.minAngleDeg : 25,
    maxAreaPercent:
      typeof candidate.maxAreaPercent === "number" ? candidate.maxAreaPercent : 1,
  };
}

/** Triggers a client-side download without touching the network. */
export function download(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked on the next tick; revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
