"use client";

import { NumberInput } from "../controls";
import { loopEntries } from "../../lib/solve";
import {
  GAS_CONDITION_KINDS,
  GAS_CONDITION_TONES,
  DEFAULT_GAS_CONDITION,
  machOf,
} from "../../lib/transient";
import type { EdgeRef } from "../MeshCanvas";
import type { Loop } from "../../lib/mesh";
import type { EdgeKey, LoopKey } from "../../lib/solve";
import type {
  GasConditionKind,
  GasConditionValue,
  GasConditions,
  InflowSchedule,
} from "../../lib/transient";

function loopLabel(key: LoopKey): string {
  return key === "boundary" ? "Outer boundary" : `Hole ${Number(key.split(":")[1]) + 1}`;
}

/**
 * The per-edge gas boundary editor.
 *
 * Modelled directly on `PhysicsPanel`, because the interaction is the same one
 * and there is no reason for it to feel different: a loop-level row per loop, an
 * indented row per edge that has been given its own condition, and a "pick
 * edges" toggle that turns clicks on the drawing into selections.
 */
export function GasBoundaryPanel({
  boundary,
  holes,
  conditions,
  editing,
  onToggleEditing,
  selectedEdge,
  onLoopCondition,
  onEdgeCondition,
  onClearEdgeCondition,
}: {
  boundary: Loop;
  holes: Loop[];
  conditions: GasConditions;
  editing: boolean;
  onToggleEditing: () => void;
  selectedEdge: EdgeRef | null;
  onLoopCondition: (key: LoopKey, next: GasConditionValue) => void;
  onEdgeCondition: (key: EdgeKey, next: GasConditionValue) => void;
  onClearEdgeCondition: (key: EdgeKey, loop: LoopKey, edge: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          What is outside each edge
        </h3>
        <button
          type="button"
          onClick={onToggleEditing}
          className="text-[11px] underline"
          style={{ color: editing ? "var(--series-1)" : "var(--text-muted)" }}
        >
          {editing ? "done" : "pick edges"}
        </button>
      </div>

      {editing && (
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Click an edge on the canvas to give it its own condition. Until then
          every edge of a loop shares the loop&apos;s.
        </p>
      )}

      {loopEntries(boundary, holes).map(({ key, loop }) => {
        const overrides = Array.from({ length: loop.length }, (_, edge) => edge).filter(
          (edge) => conditions.edges[`${key}:${edge}` as EdgeKey] !== undefined,
        );

        return (
          <div key={key} className="space-y-1.5">
            <GasConditionRow
              label={loopLabel(key)}
              value={conditions.loops[key] ?? DEFAULT_GAS_CONDITION}
              onChange={(next) => onLoopCondition(key, next)}
            />
            {overrides.map((edge) => {
              const edgeKey = `${key}:${edge}` as EdgeKey;
              return (
                <GasConditionRow
                  key={edgeKey}
                  label={`Edge ${edge + 1}`}
                  nested
                  highlighted={selectedEdge?.key === key && selectedEdge.edge === edge}
                  value={conditions.edges[edgeKey] ?? DEFAULT_GAS_CONDITION}
                  onChange={(next) => onEdgeCondition(edgeKey, next)}
                  onRemove={() => onClearEdgeCondition(edgeKey, key, edge)}
                />
              );
            })}
          </div>
        );
      })}

      <ToneLegend />
    </div>
  );
}

/** What each stroke on the drawing means. */
function ToneLegend() {
  return (
    <dl className="space-y-1 border-t pt-2" style={{ borderColor: "var(--border)" }}>
      {GAS_CONDITION_KINDS.map(({ kind, label, hint }) => {
        const tone = GAS_CONDITION_TONES[kind];
        return (
          <div key={kind} className="flex items-center gap-2">
            <svg width="28" height="8" aria-hidden className="shrink-0">
              <line
                x1="1"
                y1="4"
                x2="27"
                y2="4"
                stroke={`var(${tone.token})`}
                strokeWidth={tone.width}
                strokeDasharray={tone.dash.join(" ") || undefined}
              />
            </svg>
            <dt className="text-[11px] font-medium">{label}</dt>
            <dd className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {hint}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * One condition, with the fields its kind uses.
 *
 * The value carries every field for every kind, so switching to Wall and back
 * returns the inflow state exactly as it was typed. `toGasSpec` is what drops
 * the unused ones on the way to the solver.
 */
function GasConditionRow({
  label,
  value,
  nested,
  highlighted,
  onChange,
  onRemove,
}: {
  label: string;
  value: GasConditionValue;
  nested?: boolean;
  highlighted?: boolean;
  onChange: (next: GasConditionValue) => void;
  onRemove?: () => void;
}) {
  const mach = machOf(value.state);

  return (
    <div
      className={`space-y-1.5 rounded border p-2 ${nested ? "ml-3" : ""}`}
      style={{ borderColor: highlighted ? "var(--series-1)" : "var(--border)" }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-[11px] underline"
            style={{ color: "var(--text-muted)" }}
          >
            remove
          </button>
        )}
      </div>

      <select
        value={value.kind}
        onChange={(event) =>
          onChange({ ...value, kind: event.target.value as GasConditionKind })
        }
        className="w-full rounded border bg-transparent px-1.5 py-1 text-xs"
        style={{ borderColor: "var(--border)" }}
      >
        {GAS_CONDITION_KINDS.map(({ kind, label, hint }) => (
          <option key={kind} value={kind}>
            {label} — {hint}
          </option>
        ))}
      </select>

      {value.kind === "outflow" && (
        <label className="flex items-center gap-1.5">
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            back p
          </span>
          <NumberInput
            value={value.pressure}
            min={1e-9}
            onChange={(pressure) => onChange({ ...value, pressure })}
            className="tabular w-full rounded border bg-transparent px-1.5 py-1 text-xs"
            style={{ borderColor: "var(--border)" }}
          />
        </label>
      )}

      {value.kind === "inflow" && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <LabelledNumber
              label="density"
              value={value.state.density}
              min={1e-9}
              onChange={(density) =>
                onChange({ ...value, state: { ...value.state, density } })
              }
            />
            <LabelledNumber
              label="pressure"
              value={value.state.pressure}
              min={1e-9}
              onChange={(pressure) =>
                onChange({ ...value, state: { ...value.state, pressure } })
              }
            />
            <LabelledNumber
              label="u"
              value={value.state.velocity[0]}
              onChange={(u) =>
                onChange({
                  ...value,
                  state: { ...value.state, velocity: [u, value.state.velocity[1]] },
                })
              }
            />
            <LabelledNumber
              label="v"
              value={value.state.velocity[1]}
              onChange={(v) =>
                onChange({
                  ...value,
                  state: { ...value.state, velocity: [value.state.velocity[0], v] },
                })
              }
            />
          </div>

          {/* The regime is not a setting — it is read off the state, and it
              decides how many of the four components may be imposed. */}
          <p className="tabular text-[11px]" style={{ color: "var(--text-muted)" }}>
            Mach {mach.toFixed(2)} —{" "}
            {mach >= 1
              ? "supersonic, the whole state is imposed"
              : "subsonic, pressure comes from inside"}
          </p>

          <ScheduleField
            value={value.schedule}
            onChange={(schedule) => onChange({ ...value, schedule })}
          />
        </div>
      )}
    </div>
  );
}

function LabelledNumber({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <NumberInput
        value={value}
        min={min}
        onChange={onChange}
        className="tabular mt-0.5 w-full rounded border bg-transparent px-1.5 py-1 text-xs"
        style={{ borderColor: "var(--border)" }}
      />
    </label>
  );
}

/** How the inflow's state moves with time. */
function ScheduleField({
  value,
  onChange,
}: {
  value: InflowSchedule;
  onChange: (next: InflowSchedule) => void;
}) {
  const change = (kind: InflowSchedule["kind"]) => {
    switch (kind) {
      case "steady":
        return onChange({ kind: "steady" });
      case "ramp":
        return onChange({ kind: "ramp", over: 1 });
      case "pulse":
        return onChange({ kind: "pulse", start: 0, end: 1 });
      case "oscillation":
        return onChange({ kind: "oscillation", period: 2 });
    }
  };

  return (
    <div className="space-y-1.5">
      <select
        value={value.kind}
        onChange={(event) => change(event.target.value as InflowSchedule["kind"])}
        className="w-full rounded border bg-transparent px-1.5 py-1 text-xs"
        style={{ borderColor: "var(--border)" }}
      >
        <option value="steady">Steady</option>
        <option value="ramp">Ramp up</option>
        <option value="pulse">Pulse</option>
        <option value="oscillation">Oscillate</option>
      </select>

      {value.kind === "ramp" && (
        <LabelledNumber
          label="over"
          value={value.over}
          min={1e-9}
          onChange={(over) => onChange({ kind: "ramp", over })}
        />
      )}
      {value.kind === "pulse" && (
        <div className="grid grid-cols-2 gap-1.5">
          <LabelledNumber
            label="from"
            value={value.start}
            onChange={(start) => onChange({ ...value, start })}
          />
          <LabelledNumber
            label="until"
            value={value.end}
            onChange={(end) => onChange({ ...value, end })}
          />
        </div>
      )}
      {value.kind === "oscillation" && (
        <LabelledNumber
          label="period"
          value={value.period}
          min={1e-9}
          onChange={(period) => onChange({ kind: "oscillation", period })}
        />
      )}

      {value.kind !== "steady" && (
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          The state runs between still air and the one above. A subsonic inflow
          ignores the pressure part of it.
        </p>
      )}
    </div>
  );
}
