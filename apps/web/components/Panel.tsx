"use client";

import type { ReactNode } from "react";

/**
 * A collapsible section of the sidebar.
 *
 * The sidebar covers a whole workflow -- draw, refine, state the physics, solve,
 * export -- and only one step of it is usually in hand. Stacked open, the step
 * being worked on is as often as not below the fold; collapsed, each panel is
 * one line and the whole workflow is visible at once.
 *
 * Which is why a collapsed panel still has to say something. A header that
 * reported only its own name would make collapsing a section the same as
 * forgetting it, so `summary` carries the state that would otherwise be lost --
 * the element count, the physics constants -- and a panel is worth collapsing
 * without losing track of what it holds.
 */
export interface PanelProps {
  id: string;
  title: string;
  /**
   * What the panel says when closed: the one number or phrase that makes
   * opening it unnecessary. May be interactive -- it sits outside the toggle.
   */
  summary?: ReactNode;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}

export function Panel({ id, title, summary, open, onToggle, children }: PanelProps) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={open}
          className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-xs font-semibold tracking-wide uppercase"
          style={{ color: "var(--text-muted)" }}
        >
          <Chevron open={open} />
          <span className="truncate">{title}</span>
        </button>

        {summary != null && (
          <span
            className="shrink-0 text-xs normal-case"
            style={{ color: "var(--text-muted)" }}
          >
            {summary}
          </span>
        )}
      </div>

      {/* Unmounted rather than hidden. Nothing in a closed panel is expensive to
          rebuild, and a hidden <input> is still focusable by keyboard, which
          would let tabbing wander into a section that is not on screen. */}
      {open && <div className="mt-2 space-y-3">{children}</div>}
    </section>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      className="h-2 w-2 shrink-0 transition-transform"
      style={{ transform: open ? "rotate(90deg)" : "none" }}
    >
      <path d="M2 0.5 L6.5 4 L2 7.5 Z" fill="currentColor" />
    </svg>
  );
}
