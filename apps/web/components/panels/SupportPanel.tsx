"use client";

import { NumberInput } from "../controls";
import type { EdgeRef } from "../MeshCanvas";
import type { Loop } from "../../lib/mesh";
import {
  DEFAULT_ELASTIC_CONDITION,
  ELASTIC_CONDITION_KINDS,
  holdsDisplacement,
  type ElasticConditionKind,
  type ElasticConditions,
  type ElasticConditionValue,
} from "../../lib/elastic";
import { loopEntries, type EdgeKey, type LoopKey } from "../../lib/solve";

interface SupportPanelProps {
  boundary: Loop;
  holes: Loop[];
  /** Conditions already reconciled against the geometry currently drawn. */
  conditions: ElasticConditions;

  editing: boolean;
  onToggleEditing: () => void;
  selectedEdge: EdgeRef | null;
  onLoopCondition: (key: LoopKey, next: ElasticConditionValue) => void;
  onEdgeCondition: (key: EdgeKey, next: ElasticConditionValue) => void;
  onClearEdgeCondition: (key: EdgeKey, loop: LoopKey, edge: number) => void;
}

/**
 * What holds the part and what pushes on it.
 *
 * Same two-level model as the other studies -- a loop states what its wall
 * generally is, an edge override is an exception -- but the panel opens with a
 * warning the others do not need. A solid with nothing holding it has no answer
 * at all, not merely an arbitrary one, so it is worth saying before the solve
 * refuses rather than after.
 */
export function SupportPanel({
  boundary,
  holes,
  conditions,
  editing,
  onToggleEditing,
  selectedEdge,
  onLoopCondition,
  onEdgeCondition,
  onClearEdgeCondition,
}: SupportPanelProps) {
  const entries = loopEntries(boundary, holes);

  const anySupport = entries.some(({ key, loop }) => {
    if (holdsDisplacement((conditions.loops[key] ?? DEFAULT_ELASTIC_CONDITION).kind)) {
      return true;
    }
    return Array.from({ length: loop.length }).some((_, edge) => {
      const override = conditions.edges[`${key}:${edge}` as EdgeKey];
      return override !== undefined && holdsDisplacement(override.kind);
    });
  });

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          Supports and loads
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
          Click an edge on the canvas to give it its own support or load. Until
          then every edge of a loop shares the loop&apos;s.
        </p>
      )}

      {!anySupport && (
        <p
          className="rounded border p-2 text-[11px]"
          style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
        >
          <strong style={{ color: "var(--text-primary)" }}>Nothing holds this part.</strong>{" "}
          A solid free to move has no determined stress, so the solve will refuse
          it. Fix an edge, or use rollers in two perpendicular directions.
        </p>
      )}

      {entries.map(({ key, loop }) => {
        const overrides = Array.from({ length: loop.length }, (_, edge) => edge).filter(
          (edge) => conditions.edges[`${key}:${edge}` as EdgeKey] !== undefined,
        );

        return (
          <div key={key} className="space-y-1.5">
            <SupportRow
              label={
                key === "boundary"
                  ? "Outer boundary"
                  : `Hole ${Number(key.split(":")[1]) + 1}`
              }
              value={conditions.loops[key] ?? DEFAULT_ELASTIC_CONDITION}
              onChange={(next) => onLoopCondition(key, next)}
            />
            {overrides.map((edge) => {
              const edgeKey = `${key}:${edge}` as EdgeKey;
              return (
                <SupportRow
                  key={edgeKey}
                  label={`Edge ${edge + 1}`}
                  nested
                  highlighted={selectedEdge?.key === key && selectedEdge.edge === edge}
                  value={conditions.edges[edgeKey] ?? DEFAULT_ELASTIC_CONDITION}
                  onChange={(next) => onEdgeCondition(edgeKey, next)}
                  onRemove={() => onClearEdgeCondition(edgeKey, key, edge)}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/** How each kind labels the two numbers it takes, if it takes any. */
const VECTOR_LABEL: Partial<Record<ElasticConditionKind, [string, string]>> = {
  displacement: ["ux =", "uy ="],
  traction: ["px =", "py ="],
  force: ["Fx =", "Fy ="],
};

/**
 * One support or load: which kind, and its data.
 *
 * The labels state the mechanics rather than the boundary-condition taxonomy --
 * "Pressure" and "Force (total)" rather than Neumann -- and in the units a load
 * is quoted in. The sign conversion the solver needs (`J·n = −t`, because the
 * flux is the negated stress) lives in Rust, so a pressure typed here is a
 * pressure and pushing along +y means pushing along +y.
 */
function SupportRow({
  label,
  value,
  nested,
  highlighted,
  onChange,
  onRemove,
}: {
  label: string;
  value: ElasticConditionValue;
  nested?: boolean;
  highlighted?: boolean;
  onChange: (next: ElasticConditionValue) => void;
  onRemove?: () => void;
}) {
  const entry = ELASTIC_CONDITION_KINDS.find((kind) => kind.value === value.kind);
  const vector = VECTOR_LABEL[value.kind];

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
          onChange({ ...value, kind: event.target.value as ElasticConditionKind })
        }
        className="mt-1 w-full rounded border bg-transparent px-1 py-0.5 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
      >
        {(["Support", "Load"] as const).map((group) => (
          <optgroup key={group} label={group}>
            {ELASTIC_CONDITION_KINDS.filter((kind) => kind.group === group).map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {entry && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {entry.hint}
        </p>
      )}

      {vector && (
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          {([0, 1] as const).map((axis) => (
            <div key={axis} className="flex items-center gap-1">
              <span
                className="shrink-0 text-[11px] whitespace-nowrap"
                style={{ color: "var(--text-muted)" }}
              >
                {vector[axis]}
              </span>
              <NumberInput
                value={axis === 0 ? value.x : value.y}
                onChange={(next) =>
                  onChange(axis === 0 ? { ...value, x: next } : { ...value, y: next })
                }
                className="tabular min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs"
                style={{ borderColor: "var(--border)" }}
              />
            </div>
          ))}
        </div>
      )}

      {value.kind === "spring" && (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="shrink-0 text-[11px]" style={{ color: "var(--text-muted)" }}>
            k =
          </span>
          <NumberInput
            value={value.stiffness}
            min={1e-9}
            onChange={(next) => onChange({ ...value, stiffness: next })}
            className="tabular min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs"
            style={{
              // The solver refuses a non-positive stiffness, so say so here
              // rather than letting the request come back as an error.
              borderColor: value.stiffness > 0 ? "var(--border)" : "var(--status-critical)",
            }}
          />
        </div>
      )}
    </div>
  );
}
