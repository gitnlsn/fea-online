"use client";

import { useState } from "react";

interface AngleHistogramProps {
  /** Triangle counts per equal-width bucket spanning 0..60 degrees. */
  buckets: number[];
  /** Requested minimum angle, drawn as a threshold marker. */
  targetDeg: number;
  onSelectBucket?: (range: [number, number] | null) => void;
  selected: [number, number] | null;
}

/**
 * Distribution of element minimum angles.
 *
 * A single series, so no legend box -- the heading names it. The x scale stops
 * at 60 degrees because the smallest angle of a triangle is at most 60, reached
 * only by the equilateral case; extending to 90 would leave a third of the plot
 * permanently empty.
 */
export function AngleHistogram({
  buckets,
  targetDeg,
  onSelectBucket,
  selected,
}: AngleHistogramProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  const width = 60 / Math.max(1, buckets.length);
  const max = Math.max(1, ...buckets);
  const total = buckets.reduce((sum, count) => sum + count, 0);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Element minimum angle
        </h3>
        <span className="tabular text-xs" style={{ color: "var(--text-muted)" }}>
          {total.toLocaleString()} elements
        </span>
      </div>

      <div
        className="relative flex h-24 items-end gap-[2px] rounded-sm px-1 pt-1"
        style={{ background: "var(--surface)" }}
      >
        {/* Threshold marker: where the requested quality target falls. */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 z-10 border-l border-dashed"
          style={{
            left: `${(targetDeg / 60) * 100}%`,
            borderColor: "var(--text-muted)",
          }}
          aria-hidden
        />

        {buckets.map((count, index) => {
          const from = index * width;
          const to = from + width;
          const isSelected = selected?.[0] === from;
          const isHovered = hovered === index;

          return (
            <button
              key={index}
              type="button"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
              onClick={() =>
                onSelectBucket?.(isSelected ? null : ([from, to] as [number, number]))
              }
              // Hit target spans the full column height, not just the bar.
              className="group relative flex h-full flex-1 cursor-pointer items-end"
              aria-label={`${count} elements between ${from.toFixed(0)} and ${to.toFixed(0)} degrees`}
            >
              <div
                className="w-full rounded-t-[4px] transition-opacity"
                style={{
                  height: `${(count / max) * 100}%`,
                  minHeight: count > 0 ? 2 : 0,
                  background: "var(--series-1)",
                  opacity: isSelected || isHovered ? 1 : selected ? 0.4 : 0.85,
                }}
              />
              {isHovered && (
                <div
                  className="tabular pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 rounded px-1.5 py-1 text-[11px] whitespace-nowrap"
                  style={{
                    background: "var(--surface)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border)",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                  }}
                >
                  {count} el · {from.toFixed(0)}–{to.toFixed(0)}°
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div
        className="tabular mt-1 flex justify-between text-[10px]"
        style={{ color: "var(--text-muted)" }}
      >
        <span>0°</span>
        <span>30°</span>
        <span>60°</span>
      </div>
    </div>
  );
}
