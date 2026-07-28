"use client";

import type { Playback } from "../hooks/usePlayback";

/**
 * Scrub and play/pause for a transient run, shown over the viewport.
 *
 * Over the viewport rather than in the sidebar because it is the one control
 * whose effect you have to be *looking at the picture* to judge. Everything in
 * the sidebar states a problem; this one moves through an answer.
 *
 * The track shows how much of the run exists yet. Frames arrive over several
 * seconds and can be scrubbed while the rest are still being computed, so the
 * slider's range grows underneath the handle -- and without the filled portion
 * there would be nothing to distinguish "the run ends here" from "the run has
 * only got this far".
 */
export function TimeSlider({
  playback,
  frames,
  total,
  time,
  endTime,
}: {
  playback: Playback;
  /** Frames available now. */
  frames: number;
  /** Frames the run will have when it finishes. */
  total: number;
  /** Simulation time at the current frame. */
  time: number;
  endTime: number;
}) {
  if (frames < 1) return null;

  const collected = total > 0 ? frames / total : 0;
  const last = Math.max(0, frames - 1);

  return (
    <div
      className="absolute bottom-3 left-3 right-3 flex items-center gap-3 rounded border px-3 py-2 backdrop-blur"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "color-mix(in srgb, var(--surface) 85%, transparent)",
      }}
    >
      <button
        type="button"
        onClick={playback.toggle}
        disabled={frames < 2}
        className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-40"
        style={{ borderColor: "var(--border)" }}
        aria-label={playback.playing ? "Pause" : "Play"}
      >
        {playback.playing ? "Pause" : "Play"}
      </button>

      <div className="relative flex-1">
        {/* How much of the run has been computed, behind the handle. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded"
          style={{ backgroundColor: "var(--border)" }}
        >
          <div
            className="h-full rounded"
            style={{
              width: `${collected * 100}%`,
              backgroundColor: "var(--series-1)",
              opacity: collected < 1 ? 1 : 0,
            }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.min(playback.frame, last)}
          onChange={(event) => {
            playback.pause();
            playback.seek(Number(event.target.value));
          }}
          className="relative w-full"
          aria-label="Time"
        />
      </div>

      <span className="tabular text-xs" style={{ color: "var(--text-secondary)" }}>
        t = {time.toFixed(4)}
      </span>
      <span className="tabular text-[11px]" style={{ color: "var(--text-muted)" }}>
        {Math.min(playback.frame + 1, frames)}/{total}
        {endTime > 0 ? ` to ${endTime}` : ""}
      </span>
    </div>
  );
}
