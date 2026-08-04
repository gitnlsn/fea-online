"use client";

/** Which equation the app is set up to solve. */
export type Study = "steady" | "transient" | "elastic";

/**
 * Picks the equation, and with it which half of the sidebar applies.
 *
 * The two studies solve different equations, take entirely different boundary
 * conditions, and produce different things — a field against a film. Showing
 * both sets of controls at once meant a sidebar where conductivity sat directly
 * above a blast radius with nothing to say they were unrelated, and the
 * conditions listed under Physics had no bearing on the gas at all.
 *
 * So this hides rather than groups. In Air there is no conductivity on screen to
 * be mistaken for a gas property.
 */
export function StudySwitch({
  study,
  onChange,
}: {
  study: Study;
  onChange: (next: Study) => void;
}) {
  const options: { value: Study; label: string; hint: string }[] = [
    { value: "steady", label: "Diffusion", hint: "−∇·(k∇u) = s" },
    { value: "elastic", label: "Solid", hint: "∇·σ + b = 0" },
    { value: "transient", label: "Air", hint: "Euler" },
  ];

  return (
    <div className="flex gap-px" role="group" aria-label="Equation">
      {options.map(({ value, label, hint }) => {
        const active = study === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={active}
            title={hint}
            className="flex-1 rounded border px-2 py-1.5 text-xs font-medium"
            style={{
              borderColor: active ? "var(--series-1)" : "var(--border)",
              color: active ? "var(--surface)" : "var(--text-secondary)",
              backgroundColor: active ? "var(--series-1)" : "transparent",
            }}
          >
            {label}
            <span
              className="block text-[10px] font-normal"
              style={{ color: active ? "var(--surface)" : "var(--text-muted)", opacity: 0.85 }}
            >
              {hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}
