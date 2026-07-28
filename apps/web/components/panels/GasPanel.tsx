"use client";

import { NumberField } from "../controls";
import { blastInitial } from "../../lib/transient";
import type { TransientSettings } from "../../lib/transient";

/** What the domain is filled with when the run starts. */
export function GasPanel({
  settings,
  onChange,
  world,
}: {
  settings: TransientSettings;
  onChange: (next: TransientSettings) => void;
  /** Extent of the world box, so the presets land somewhere sensible. */
  world: number;
}) {
  const update = (patch: Partial<TransientSettings>) => onChange({ ...settings, ...patch });
  const { initial } = settings;

  return (
    <div className="space-y-3">
      <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        Compressible air, γ = 1.4. States are given as density, velocity and
        pressure — the variables a person reasons about. The solver carries mass,
        momentum and energy instead, which is what puts a shock in the right place.
      </p>

      <div className="flex gap-1">
        {(
          [
            { kind: "blast", label: "Blast" },
            { kind: "riemann", label: "Shock tube" },
            { kind: "uniform", label: "Still air" },
          ] as const
        ).map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              if (kind === initial.kind) return;
              update({
                initial:
                  kind === "blast"
                    ? blastInitial([world / 2, world / 2], world / 10, 10)
                    : kind === "riemann"
                      ? {
                          kind: "riemann",
                          normal: [1, 0],
                          position: world / 2,
                          left: { density: 1, velocity: [0, 0], pressure: 1 },
                          right: { density: 0.125, velocity: [0, 0], pressure: 0.1 },
                        }
                      : {
                          kind: "uniform",
                          state: { density: 1, velocity: [0, 0], pressure: 1 },
                        },
              });
            }}
            className="flex-1 rounded border px-2 py-1 text-xs"
            style={{
              borderColor: initial.kind === kind ? "var(--series-1)" : "var(--border)",
              color: initial.kind === kind ? "var(--series-1)" : "var(--text-secondary)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {initial.kind === "blast" && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Centre x"
            value={initial.centre[0]}
            onChange={(x) => update({ initial: { ...initial, centre: [x, initial.centre[1]] } })}
          />
          <NumberField
            label="Centre y"
            value={initial.centre[1]}
            onChange={(y) => update({ initial: { ...initial, centre: [initial.centre[0], y] } })}
          />
          <NumberField
            label="Radius"
            value={initial.radius}
            min={1e-6}
            onChange={(radius) => update({ initial: { ...initial, radius } })}
          />
          <NumberField
            label="Pressure ratio"
            value={initial.inside.pressure}
            min={1e-6}
            onChange={(ratio) =>
              update({ initial: blastInitial(initial.centre, initial.radius, ratio) })
            }
          />
        </div>
      )}

      {initial.kind === "riemann" && (
        <NumberField
          label="Diaphragm at x"
          value={initial.position}
          onChange={(position) => update({ initial: { ...initial, position } })}
        />
      )}

      {initial.kind === "uniform" && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Density"
            value={initial.state.density}
            min={1e-9}
            onChange={(density) =>
              update({ initial: { ...initial, state: { ...initial.state, density } } })
            }
          />
          <NumberField
            label="Pressure"
            value={initial.state.pressure}
            min={1e-9}
            onChange={(pressure) =>
              update({ initial: { ...initial, state: { ...initial.state, pressure } } })
            }
          />
        </div>
      )}
    </div>
  );
}
