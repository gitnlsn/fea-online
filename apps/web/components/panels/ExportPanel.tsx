"use client";

import { ExportButton } from "../controls";
import {
  download,
  parseGeometryJson,
  toGeometryJson,
  toGmsh,
  toVtk,
  toVtkField,
  type GeometryDocument,
} from "../../lib/export";
import type { Loop, MeshResponse } from "../../lib/mesh";
import type { SolveResponse } from "../../lib/solve";

interface ExportPanelProps {
  mesh: MeshResponse | null;
  solution: SolveResponse | null;
  boundary: Loop | null;
  holes: Loop[];
  minAngleDeg: number;
  maxAreaPercent: number;
  loadError: string | null;
  onLoad: (loaded: GeometryDocument) => void;
  onLoadError: (message: string | null) => void;
}

/** Everything on screen, in a form another tool will read. */
export function ExportPanel({
  mesh,
  solution,
  boundary,
  holes,
  minAngleDeg,
  maxAreaPercent,
  loadError,
  onLoad,
  onLoadError,
}: ExportPanelProps) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <ExportButton
          label="Gmsh .msh"
          disabled={!mesh}
          onClick={() => mesh && download("mesh.msh", toGmsh(mesh))}
        />
        <ExportButton
          label="VTK .vtk"
          disabled={!mesh}
          onClick={() => mesh && download("mesh.vtk", toVtk(mesh))}
        />
        <ExportButton
          label="Solution .vtk"
          disabled={!solution}
          onClick={() => solution && download("solution.vtk", toVtkField(solution))}
        />
        <ExportButton
          label="Geometry .json"
          disabled={!boundary}
          onClick={() =>
            download(
              "geometry.json",
              toGeometryJson({ version: 1, boundary, holes, minAngleDeg, maxAreaPercent }),
            )
          }
        />
        <label
          className="cursor-pointer rounded border px-2 py-1 text-xs"
          style={{ borderColor: "var(--border)" }}
        >
          Load .json
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const result = parseGeometryJson(await file.text());
              // Reset the input so picking the same file twice re-fires.
              event.target.value = "";

              if (typeof result === "string") {
                onLoadError(result);
                return;
              }
              onLoadError(null);
              onLoad(result);
            }}
          />
        </label>
      </div>

      {loadError && (
        <p className="text-xs" style={{ color: "var(--status-critical)" }}>
          {loadError}
        </p>
      )}
    </>
  );
}
