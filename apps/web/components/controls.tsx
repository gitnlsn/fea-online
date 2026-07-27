"use client";

import { useState, type ReactNode } from "react";

/**
 * A bordered notice.
 *
 * Two tones, and the difference is whether the message is the whole point.
 * "Critical" colours its own text, because it reports something that did not
 * work and there is nothing else to read. "Warning" colours only its border and
 * leaves the text at reading contrast, because it qualifies a result that is
 * still on screen and still worth looking at.
 */
export function Alert({
  tone,
  children,
}: {
  tone: "critical" | "warning";
  children: ReactNode;
}) {
  return (
    <div
      className="rounded border p-2 text-xs"
      style={{
        borderColor: `var(--status-${tone})`,
        color: tone === "critical" ? "var(--status-critical)" : "var(--text-secondary)",
      }}
    >
      {children}
    </div>
  );
}

/** A labelled figure in a two-column grid. */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {label}
      </dt>
      <dd className="tabular text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * A numeric input that reports only values, never the text on the way to one.
 *
 * The subtlety is that "-", "1e" and "" are not numbers but are all prefixes of
 * one. Rejecting them outright -- which is what checking `Number.isFinite` on
 * every keystroke amounts to -- means the field silently refuses the first
 * character of every negative number, and a negative value cannot be typed at
 * all. So the text being edited is held here and shown as typed, while `onChange`
 * fires only when that text parses. Blur drops the draft, which is what snaps a
 * field left holding "-" back to the value actually in effect.
 */
export function NumberField({
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

/** The bare input behind `NumberField`, for rows that supply their own label. */
export function NumberInput({
  value,
  min,
  onChange,
  className,
  style,
}: {
  value: number;
  min?: number;
  onChange: (next: number) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  // Null means "not being edited", so the committed value shows through --
  // including when it is changed from elsewhere, as loading a .json does.
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      type="number"
      step="any"
      min={min}
      value={draft ?? String(value)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);

        const next = Number(text);
        if (text.trim() !== "" && Number.isFinite(next)) onChange(next);
      }}
      onBlur={() => setDraft(null)}
      className={className}
      style={style}
    />
  );
}

export function ExportButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded border px-2 py-1 text-xs disabled:opacity-40"
      style={{ borderColor: "var(--border)" }}
    >
      {label}
    </button>
  );
}

/** A labelled slider with its current value shown against the label. */
export function SliderField({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  children,
}: {
  label: string;
  value: number;
  /** The value as the reader should see it, units and all. */
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  /** A note shown under the slider, usually conditional on the value. */
  children?: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
          {label}
        </span>
        <span className="tabular text-xs font-medium">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 w-full accent-[var(--series-1)]"
      />
      {children}
    </label>
  );
}

/** A checkbox with its label, as the sidebar draws them. */
export function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-[var(--series-1)]"
      />
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
    </label>
  );
}
