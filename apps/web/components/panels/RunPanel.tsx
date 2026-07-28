"use client";

import { Alert, CheckField, NumberField, SliderField, Stat } from "../controls";
import { DERIVED_FIELDS } from "../../lib/transient";
import type { DerivedField, TransientProgress, TransientSettings } from "../../lib/transient";

/** How the run is made, and how it went. */
export function RunPanel({
  settings,
  onChange,
  status,
  progress,
  frameCount,
  elapsedMs,
  error,
  stale,
  canRun,
  onRun,
  onCancel,
}: {
  settings: TransientSettings;
  onChange: (next: TransientSettings) => void;
  status: "idle" | "running" | "ready" | "error";
  progress: TransientProgress | null;
  frameCount: number;
  elapsedMs: number;
  error: string | null;
  stale: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<TransientSettings>) => onChange({ ...settings, ...patch });
  const running = status === "running";

  // Grouped in the order the list declares, so related scalars sit together.
  const groups = DERIVED_FIELDS.reduce<Record<string, typeof DERIVED_FIELDS>>((into, field) => {
    (into[field.group] ??= []).push(field);
    return into;
  }, {});

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="End time"
          value={settings.endTime}
          min={1e-6}
          onChange={(endTime) => update({ endTime })}
        />
        <NumberField
          label="Frames"
          value={settings.frames}
          min={2}
          onChange={(frames) => update({ frames: Math.round(frames) })}
        />
      </div>

      <label className="block">
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Colour by
        </span>
        <select
          value={settings.field}
          onChange={(event) => update({ field: event.target.value as DerivedField })}
          className="mt-0.5 w-full rounded border bg-transparent px-1.5 py-1 text-xs"
          style={{ borderColor: "var(--border)" }}
        >
          {Object.entries(groups).map(([group, fields]) => (
            <optgroup key={group} label={group}>
              {fields.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {/* Velocity is not in the list above, and this is why. */}
      <CheckField
        label="Velocity arrows"
        checked={settings.showVectors}
        onChange={(showVectors) => update({ showVectors })}
      />
      <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        Velocity is a vector, so it is drawn as arrows over whichever scalar is
        coloured rather than being one of them. Colouring by its magnitude alone
        would throw away the direction, which is most of what it says.
      </p>

      <SliderField
        label="Degree p"
        value={settings.degree}
        display={String(settings.degree)}
        min={1}
        max={3}
        step={1}
        onChange={(degree) => update({ degree })}
      >
        {settings.degree > 1 && (
          <span>
            A higher degree does not pay off across a shock: the limiter reduces
            any element it touches to a straight line whatever its degree, and
            across a shock it touches most of them.
          </span>
        )}
      </SliderField>

      <SliderField
        label="CFL fraction"
        value={settings.cfl}
        display={settings.cfl.toFixed(2)}
        min={0.05}
        max={0.9}
        step={0.05}
        onChange={(cfl) => update({ cfl })}
      >
        {settings.cfl > 0.5 && (
          <span>
            Above about 0.5 there is little margin for a wave speed that rises
            during the step, which is how a nonlinear run goes unstable.
          </span>
        )}
      </SliderField>

      <CheckField
        label="Limit smooth extrema too"
        checked={settings.limiter === 0}
        onChange={(checked) => update({ limiter: checked ? 0 : 20 })}
      />

      <button
        type="button"
        onClick={running ? onCancel : onRun}
        disabled={!running && !canRun}
        className="w-full rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40"
        style={{
          backgroundColor: running ? "transparent" : "var(--series-1)",
          border: running ? "1px solid var(--border)" : "none",
          color: running ? "var(--text-secondary)" : "var(--surface)",
        }}
      >
        {running ? "Stop" : "Run"}
      </button>

      {running && (
        <div className="h-1 w-full overflow-hidden rounded" style={{ backgroundColor: "var(--border)" }}>
          <div
            className="h-full"
            style={{
              width: `${(frameCount / Math.max(1, settings.frames)) * 100}%`,
              backgroundColor: "var(--series-1)",
            }}
          />
        </div>
      )}

      {error && <Alert tone="critical">{error}</Alert>}

      {stale && frameCount > 0 && (
        <Alert tone="warning">
          The problem has changed since this ran. What you are watching answers
          the previous one.
        </Alert>
      )}

      {progress && progress.unrecoverable > 0 && (
        <Alert tone="warning">
          {progress.unrecoverable} element-stages had a cell average that was no
          longer a gas. The scheme failed before the limiter could act, and the
          picture past that point is not a solution.
        </Alert>
      )}

      {frameCount > 0 && progress && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="Frames" value={`${frameCount} / ${settings.frames}`} />
          <Stat label="Steps" value={progress.steps.toLocaleString()} />
          <Stat label="Time reached" value={progress.time.toPrecision(4)} />
          <Stat
            label="Smallest step"
            value={
              Number.isFinite(progress.smallest_step)
                ? progress.smallest_step.toExponential(2)
                : "—"
            }
          />
          {status === "ready" && <Stat label="Elapsed" value={`${Math.round(elapsedMs)} ms`} />}
        </dl>
      )}
    </div>
  );
}
