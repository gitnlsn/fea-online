"use client";

import { Alert, CheckField, SliderField, Stat } from "../controls";
import { FieldRamp, formatValue } from "../FieldLegend";
import {
  ELASTIC_FIELDS,
  type ElasticField,
  type ElasticResponse,
} from "../../lib/elastic";
import type { DrawableField } from "../../lib/solve";

interface StressPanelProps {
  canSolve: boolean;
  solving: boolean;
  /** The mesh is being rebuilt, so there is nothing settled to solve on. */
  meshIsStale: boolean;
  onSolve: () => void;

  solution: ElasticResponse | null;
  /** The derived scalar currently drawn, so the legend describes what is on screen. */
  field: DrawableField | null;
  solutionIsStale: boolean;
  solveError: string | null;
  elapsedMs: number;

  selectedField: ElasticField;
  onFieldChange: (next: ElasticField) => void;

  planView: boolean;
  showField: boolean;
  onShowFieldChange: (next: boolean) => void;

  /** Multiples of the automatic warp, so 1 is always a readable view. */
  deformation: number;
  onDeformationChange: (next: number) => void;
  exaggeration: number;
  onExaggerationChange: (next: number) => void;
}

/** Running the solve, choosing what to look at, and reading the answer. */
export function StressPanel({
  canSolve,
  solving,
  meshIsStale,
  onSolve,
  solution,
  field,
  solutionIsStale,
  solveError,
  elapsedMs,
  selectedField,
  onFieldChange,
  planView,
  showField,
  onShowFieldChange,
  deformation,
  onDeformationChange,
  exaggeration,
  onExaggerationChange,
}: StressPanelProps) {
  const relativeResidual =
    solution && solution.initial_norm > 0
      ? solution.residual_norm / solution.initial_norm
      : 0;

  const groups = Array.from(new Set(ELASTIC_FIELDS.map((entry) => entry.group)));

  return (
    <>
      <button
        type="button"
        onClick={onSolve}
        disabled={!canSolve}
        className="w-full rounded border px-2 py-1.5 text-xs transition-colors disabled:opacity-40"
        style={{
          borderColor: canSolve ? "var(--series-1)" : "var(--border)",
          color: canSolve ? "var(--series-1)" : "var(--text-muted)",
        }}
      >
        {solving ? "Solving…" : meshIsStale ? "Waiting for the mesh…" : "Solve"}
      </button>

      {solveError && (
        <Alert tone="critical">
          <strong>Solve failed.</strong> {solveError}
        </Alert>
      )}

      {solution && (
        <>
          {/* Changing this is a render, not a re-solve: the response carries
              displacement and strain, and every scalar below is an algebraic
              function of those two. */}
          <label className="block">
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Show
            </span>
            <select
              value={selectedField}
              onChange={(event) => onFieldChange(event.target.value as ElasticField)}
              className="mt-0.5 w-full rounded border bg-transparent px-1 py-1 text-xs"
              style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
            >
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {ELASTIC_FIELDS.filter((entry) => entry.group === group).map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <SliderField
            label="Deformation"
            display={deformation === 0 ? "undeformed" : `${deformation.toFixed(1)}×`}
            value={deformation}
            min={0}
            max={3}
            step={0.1}
            onChange={onDeformationChange}
          >
            <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
              The shape is exaggerated to be visible — at 1× the largest movement
              is drawn as a twentieth of the part. Slide to 0 to compare against
              the shape as drawn.
            </p>
          </SliderField>

          {planView ? (
            <CheckField label="Show field" checked={showField} onChange={onShowFieldChange} />
          ) : (
            <SliderField
              label="Vertical exaggeration"
              display={`${exaggeration.toFixed(1)}×`}
              value={exaggeration}
              min={0.1}
              max={4}
              step={0.1}
              onChange={onExaggerationChange}
            >
              <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                Height is scaled to fit the plan, so the vertical axis is not to
                scale and carries no units. The legend has the numbers.
              </p>
            </SliderField>
          )}

          <div style={{ opacity: solutionIsStale ? 0.45 : 1 }}>
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                {ELASTIC_FIELDS.find((entry) => entry.value === selectedField)?.label}
              </h3>
              <span className="tabular text-xs" style={{ color: "var(--text-muted)" }}>
                {elapsedMs.toFixed(0)} ms
              </span>
            </div>

            {field && <FieldRamp min={field.min_value} max={field.max_value} />}

            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
              <Stat label="Elements" value={solution.element_count.toLocaleString()} />
              <Stat label="Degree" value={`p = ${solution.degree}`} />
              <Stat
                label="Peak movement"
                value={formatValue(solution.largest_displacement)}
              />
              <Stat label="Iterations" value={solution.iterations.toLocaleString()} />
            </dl>

            {/* Non-convergence is the failure this panel exists to surface: the
                solver returns its best iterate either way, and nothing about the
                picture looks different. */}
            {!solution.converged && (
              <p
                className="mt-2 rounded border p-2 text-xs"
                style={{ borderColor: "var(--status-critical)", color: "var(--text-secondary)" }}
              >
                <strong style={{ color: "var(--status-critical)" }}>Did not converge.</strong>{" "}
                The iteration hit its cap at a relative residual of{" "}
                {relativeResidual.toExponential(1)}. The shape above is the best
                iterate reached, not a solution — coarsen the mesh, lower the
                polynomial degree, or move Poisson&apos;s ratio away from 0.5.
              </p>
            )}

            {solution.unclassified_faces > 0 && (
              <p
                className="mt-2 rounded border p-2 text-xs"
                style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
              >
                <strong style={{ color: "var(--text-primary)" }}>
                  {solution.unclassified_faces.toLocaleString()} boundary face
                  {solution.unclassified_faces === 1 ? "" : "s"}
                </strong>{" "}
                could not be matched to a drawn edge and fell back to the first
                support. The answer near them is not what was asked for.
              </p>
            )}

            {solution.degree === 1 && selectedField !== "magnitude" && (
              <p
                className="mt-2 rounded border p-2 text-xs"
                style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
              >
                <strong style={{ color: "var(--text-primary)" }}>Stress is one degree
                coarser than displacement.</strong>{" "}
                At p = 1 that leaves it constant within each element, so a peak
                read off this picture is a mesh artefact as much as a result.
                Raise the degree before quoting a number.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
