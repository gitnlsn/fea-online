"use client";

import { Stat } from "./controls";
import { fieldScale, rampStops, scaleMidpoint } from "../lib/fieldRamp";
import type { SolveResponse } from "../lib/solve";

interface FieldLegendProps {
  solution: SolveResponse;
  /** The field belongs to a problem that has since changed. */
  stale: boolean;
  elapsedMs: number;
}

/**
 * Formats a field value at a width the sidebar can hold.
 *
 * Fields span whatever range the conditions imply -- microvolts to megapascals
 * -- so a fixed number of decimals is wrong at one end or the other. Switching
 * to exponent notation outside a middle band keeps every value legible without
 * the reader having to count zeros.
 */
export function formatValue(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  if (magnitude < 1e-3 || magnitude >= 1e5) return value.toExponential(2);
  return value.toPrecision(4).replace(/\.?0+$/, "");
}

/**
 * The colour ramp with the numbers at its ends.
 *
 * Shared rather than written once per study, because it is the contract between
 * a picture and its numbers: two legends drawn by two pieces of code could
 * disagree about where the ramp diverges or what the midpoint is, and the
 * disagreement would be invisible -- both would look like legends.
 */
export function FieldRamp({ min, max }: { min: number; max: number }) {
  const scale = fieldScale(min, max);
  const stops = rampStops(scale, "var(--div-mid)");

  return (
    <>
      {/* Discrete blocks rather than a blend, because the canvas fills in the
          same discrete steps -- a smooth bar would promise a resolution the
          picture does not have. */}
      <div className="flex h-3 overflow-hidden rounded-sm" aria-hidden>
        {stops.map((color, index) => (
          <div key={index} className="flex-1" style={{ background: color }} />
        ))}
      </div>

      <div
        className="tabular mt-1 flex justify-between text-[10px]"
        style={{ color: "var(--text-muted)" }}
      >
        <span>{formatValue(min)}</span>
        <span>{formatValue(scaleMidpoint(scale))}</span>
        <span>{formatValue(max)}</span>
      </div>

      {scale.kind === "diverging" && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          The field changes sign, so the ramp diverges from zero at the middle.
          Equal distances either side of zero take equally strong colour.
        </p>
      )}
    </>
  );
}

/**
 * The scale the field is drawn against, and how well the solve went.
 *
 * The two belong together. A field's colours mean nothing without the numbers
 * at the ends of the ramp, and the numbers mean nothing if the iteration never
 * converged -- which is invisible in the picture, since a half-solved field is
 * just as smooth and just as colourful as a solved one.
 */
export function FieldLegend({ solution, stale, elapsedMs }: FieldLegendProps) {
  const relativeResidual =
    solution.initial_norm > 0 ? solution.residual_norm / solution.initial_norm : 0;

  return (
    <div style={{ opacity: stale ? 0.45 : 1 }}>
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Solution u
        </h3>
        <span className="tabular text-xs" style={{ color: "var(--text-muted)" }}>
          {elapsedMs.toFixed(0)} ms
        </span>
      </div>

      <FieldRamp min={solution.min_value} max={solution.max_value} />

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
        <Stat label="Elements" value={solution.element_count.toLocaleString()} />
        <Stat label="Degree" value={`p = ${solution.degree}`} />
        <Stat label="Iterations" value={solution.iterations.toLocaleString()} />
        <Stat label="Residual" value={relativeResidual.toExponential(1)} />
      </dl>

      {/* Non-convergence is the failure this whole panel exists to surface: the
          solver returns its best iterate either way, and nothing about the
          picture looks different. */}
      {!solution.converged && (
        <p
          className="mt-2 rounded border p-2 text-xs"
          style={{ borderColor: "var(--status-critical)", color: "var(--text-secondary)" }}
        >
          <strong style={{ color: "var(--status-critical)" }}>Did not converge.</strong>{" "}
          The iteration hit its cap at a relative residual of{" "}
          {relativeResidual.toExponential(1)}. The field above is the best
          iterate reached, not a solution — raise the iteration cap, coarsen the
          mesh, or lower the polynomial degree.
        </p>
      )}

      {solution.singular && (
        <p
          className="mt-2 rounded border p-2 text-xs"
          style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
        >
          <strong style={{ color: "var(--text-primary)" }}>Level is arbitrary.</strong>{" "}
          Every boundary prescribes a flux and none prescribes a value, so the
          field is fixed only up to a constant; it has been pinned to zero mean.
          Such a problem also has no solution at all unless the fluxes balance
          the source, and an unbalanced one still returns a plausible-looking
          answer. Set a value on at least one edge to remove the ambiguity.
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
          condition. The field near them is not what was asked for.
        </p>
      )}
    </div>
  );
}
