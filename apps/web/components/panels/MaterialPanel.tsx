"use client";

import { NumberField, SliderField } from "../controls";
import { PLANE_STATES, type PlaneState } from "../../lib/elastic";

/** Everything about the solid that is not a support or a load. */
export interface Material {
  youngsModulus: number;
  poissonRatio: number;
  plane: PlaneState;
  bodyForce: [number, number];
  degree: number;
}

/**
 * Steel, in a millimetre-newton system: 210 000 N/mm² and a ratio of 0.3.
 *
 * The tool has no unit system -- the geometry is whatever the user drew in --
 * so any default is a statement about which one to imagine. Steel in mm/N is the
 * one where the numbers a mechanical engineer already knows are the numbers
 * that go in the boxes.
 */
export const DEFAULT_MATERIAL: Material = {
  youngsModulus: 210_000,
  poissonRatio: 0.3,
  plane: "stress",
  bodyForce: [0, 0],
  degree: 2,
};

/**
 * Poisson's ratio the solver will refuse above.
 *
 * Mirrors `MAX_POISSON_RATIO` in `crates/fea-wasm/src/elastic.rs`. Stated here
 * so the input can say so before the request comes back as an error.
 */
const MAX_POISSON_RATIO = 0.495;

interface MaterialPanelProps {
  material: Material;
  onChange: (next: Material) => void;
}

/** What the part is made of, and what is pulling on all of it at once. */
export function MaterialPanel({ material, onChange }: MaterialPanelProps) {
  const set = <K extends keyof Material>(key: K, value: Material[K]) =>
    onChange({ ...material, [key]: value });

  const lockedUp = material.poissonRatio > 0.45;

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Young's modulus E"
          value={material.youngsModulus}
          min={1e-9}
          onChange={(next) => set("youngsModulus", next)}
        />
        <NumberField
          label="Poisson's ratio ν"
          value={material.poissonRatio}
          onChange={(next) =>
            set("poissonRatio", Math.min(MAX_POISSON_RATIO, Math.max(-0.99, next)))
          }
        />
      </div>

      <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        Units are whatever the drawing is in. Steel in millimetres and newtons is
        E = 210 000, ν = 0.3.
      </p>

      {lockedUp && (
        <p
          className="rounded border p-2 text-[11px]"
          style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
        >
          <strong style={{ color: "var(--text-primary)" }}>Nearly incompressible.</strong>{" "}
          Above about ν = 0.45 the material resists changing volume far more
          strongly than changing shape, and the solve takes proportionally longer
          and loses accuracy. Rubber genuinely behaves this way; steel and
          aluminium do not.
        </p>
      )}

      <div>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Idealisation
        </span>
        <div className="mt-1 flex gap-px">
          {PLANE_STATES.map(({ value, label, hint }) => {
            const active = material.plane === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => set("plane", value)}
                aria-pressed={active}
                title={hint}
                className="flex-1 rounded border px-2 py-1 text-[11px]"
                style={{
                  borderColor: active ? "var(--series-1)" : "var(--border)",
                  color: active ? "var(--surface)" : "var(--text-secondary)",
                  backgroundColor: active ? "var(--series-1)" : "transparent",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {PLANE_STATES.find((entry) => entry.value === material.plane)?.hint}
        </p>
      </div>

      <div>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Body force per unit volume
        </span>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <NumberField
            label="bx"
            value={material.bodyForce[0]}
            onChange={(next) => set("bodyForce", [next, material.bodyForce[1]])}
          />
          <NumberField
            label="by"
            value={material.bodyForce[1]}
            onChange={(next) => set("bodyForce", [material.bodyForce[0], next])}
          />
        </div>
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Gravity is ρg downward — for steel in millimetres and newtons, about
          by = −7.7e−5.
        </p>
      </div>

      <SliderField
        label="Polynomial degree"
        display={`p = ${material.degree}`}
        value={material.degree}
        min={1}
        // Capped one below the diffusion study's, matching the solver: two
        // displacement components double the unknowns and the operator is worse
        // conditioned, so the same wait buys one degree less.
        max={3}
        step={1}
        onChange={(next) => set("degree", next)}
      >
        {material.degree === 1 && (
          <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            A linear basis reports a constant strain per element, so the stress
            picture is blocky however fine the mesh. Raise the degree before
            reading a peak stress off it.
          </p>
        )}
      </SliderField>
    </>
  );
}
