"use client";

import { NumberField, NumberInput, SliderField } from "../controls";
import type { EdgeRef } from "../MeshCanvas";
import type { Loop } from "../../lib/mesh";
import {
  DEFAULT_CONDITION,
  loopEntries,
  type BoundaryConditions,
  type ConditionKind,
  type ConditionValue,
  type EdgeKey,
  type LoopKey,
} from "../../lib/solve";

interface PhysicsPanelProps {
  boundary: Loop;
  holes: Loop[];
  /** Conditions already reconciled against the geometry currently drawn. */
  conditions: BoundaryConditions;

  editingConditions: boolean;
  onToggleEditing: () => void;
  selectedEdge: EdgeRef | null;
  onLoopCondition: (key: LoopKey, next: ConditionValue) => void;
  onEdgeCondition: (key: EdgeKey, next: ConditionValue) => void;
  onClearEdgeCondition: (key: EdgeKey, loop: LoopKey, edge: number) => void;

  conductivity: number;
  onConductivityChange: (next: number) => void;
  sourceValue: number;
  onSourceChange: (next: number) => void;
  degree: number;
  onDegreeChange: (next: number) => void;
}

/**
 * The problem being posed: what the walls do, and what the material is.
 *
 * One panel rather than two, because these are the inputs that decide the
 * answer. Everything above them describes where the problem lives and
 * everything below reports how the solve went; this is the problem itself.
 */
export function PhysicsPanel({
  boundary,
  holes,
  conditions,
  editingConditions,
  onToggleEditing,
  selectedEdge,
  onLoopCondition,
  onEdgeCondition,
  onClearEdgeCondition,
  conductivity,
  onConductivityChange,
  sourceValue,
  onSourceChange,
  degree,
  onDegreeChange,
}: PhysicsPanelProps) {
  return (
    <>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
            Boundary conditions
          </h3>
          <button
            type="button"
            onClick={onToggleEditing}
            className="text-[11px] underline"
            style={{ color: editingConditions ? "var(--series-1)" : "var(--text-muted)" }}
          >
            {editingConditions ? "done" : "pick edges"}
          </button>
        </div>

        {editingConditions && (
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
              <ConditionRow
                label={
                  key === "boundary"
                    ? "Outer boundary"
                    : `Hole ${Number(key.split(":")[1]) + 1}`
                }
                value={conditions.loops[key] ?? DEFAULT_CONDITION}
                onChange={(next) => onLoopCondition(key, next)}
              />
              {overrides.map((edge) => {
                const edgeKey = `${key}:${edge}` as EdgeKey;
                return (
                  <ConditionRow
                    key={edgeKey}
                    label={`Edge ${edge + 1}`}
                    nested
                    highlighted={selectedEdge?.key === key && selectedEdge.edge === edge}
                    value={conditions.edges[edgeKey] ?? DEFAULT_CONDITION}
                    onChange={(next) => onEdgeCondition(edgeKey, next)}
                    onRemove={() => onClearEdgeCondition(edgeKey, key, edge)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Conductivity k"
          value={conductivity}
          min={1e-9}
          onChange={onConductivityChange}
        />
        <NumberField label="Source s" value={sourceValue} onChange={onSourceChange} />
      </div>

      <SliderField
        label="Polynomial degree"
        display={`p = ${degree}`}
        value={degree}
        min={1}
        max={4}
        step={1}
        onChange={onDegreeChange}
      />
    </>
  );
}

/**
 * One boundary condition: which kind, and its data.
 *
 * The labels state the physics rather than the name of the mathematician. A
 * Neumann value here is the outward *flux* `J·n`, which for diffusion is
 * `-k du/dn` -- the opposite sign to the derivative, and the single easiest
 * thing to get backwards, because a sign error still converges beautifully to
 * the wrong answer.
 */
function ConditionRow({
  label,
  value,
  nested,
  highlighted,
  onChange,
  onRemove,
}: {
  label: string;
  value: ConditionValue;
  nested?: boolean;
  highlighted?: boolean;
  onChange: (next: ConditionValue) => void;
  onRemove?: () => void;
}) {
  const kinds: { kind: ConditionKind; label: string; hint: string }[] = [
    { kind: "dirichlet", label: "Fixed value", hint: "u =" },
    { kind: "neumann", label: "Fixed flux", hint: "J·n =" },
    { kind: "robin", label: "Convective", hint: "k du/dn + c·u =" },
  ];

  return (
    <div
      className={`rounded border p-1.5 ${nested ? "ml-3" : ""}`}
      style={{ borderColor: highlighted ? "var(--series-1)" : "var(--border)" }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium">{label}</span>
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
          onChange({ ...value, kind: event.target.value as ConditionKind })
        }
        className="mt-1 w-full rounded border bg-transparent px-1 py-0.5 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
      >
        {kinds.map((entry) => (
          <option key={entry.kind} value={entry.kind}>
            {entry.label}
          </option>
        ))}
      </select>

      <div className="mt-1 flex items-center gap-1.5">
        <span
          className="shrink-0 text-[11px] whitespace-nowrap"
          style={{ color: "var(--text-muted)" }}
        >
          {kinds.find((entry) => entry.kind === value.kind)?.hint}
        </span>
        <NumberInput
          value={value.value}
          onChange={(next) => onChange({ ...value, value: next })}
          className="tabular min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs"
          style={{ borderColor: "var(--border)" }}
        />
      </div>

      {value.kind === "robin" && (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="shrink-0 text-[11px]" style={{ color: "var(--text-muted)" }}>
            c =
          </span>
          <NumberInput
            value={value.coefficient}
            min={1e-9}
            onChange={(next) => onChange({ ...value, coefficient: next })}
            className="tabular min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs"
            style={{
              // The solver refuses a non-positive coefficient, so say so here
              // rather than letting the request come back as an error.
              borderColor:
                value.coefficient > 0 ? "var(--border)" : "var(--status-critical)",
            }}
          />
        </div>
      )}
    </div>
  );
}
