"use client";

import { Alert, CheckField, SliderField } from "../controls";
import { FieldLegend } from "../FieldLegend";
import type { SolveResponse } from "../../lib/solve";

interface SolvePanelProps {
  canSolve: boolean;
  solving: boolean;
  /** The mesh is being rebuilt, so there is nothing settled to solve on. */
  meshIsStale: boolean;
  onSolve: () => void;

  solution: SolveResponse | null;
  solutionIsStale: boolean;
  solveError: string | null;
  elapsedMs: number;

  /** True while the plan view is showing; the 3D view has no field to hide. */
  planView: boolean;
  showField: boolean;
  onShowFieldChange: (next: boolean) => void;
  exaggeration: number;
  onExaggerationChange: (next: number) => void;
}

/** Running the solve, and everything the answer needs said about it. */
export function SolvePanel({
  canSolve,
  solving,
  meshIsStale,
  onSolve,
  solution,
  solutionIsStale,
  solveError,
  elapsedMs,
  planView,
  showField,
  onShowFieldChange,
  exaggeration,
  onExaggerationChange,
}: SolvePanelProps) {
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

      {solution &&
        (planView ? (
          <CheckField label="Show field" checked={showField} onChange={onShowFieldChange} />
        ) : (
          // In 3D the field *is* the surface, so there is nothing to hide; what
          // the reader needs instead is control over how tall it is.
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
        ))}

      {solveError && (
        <Alert tone="critical">
          <strong>Solve failed.</strong> {solveError}
        </Alert>
      )}

      {solution && (
        <FieldLegend
          solution={solution}
          stale={solutionIsStale}
          elapsedMs={elapsedMs}
        />
      )}
    </>
  );
}
