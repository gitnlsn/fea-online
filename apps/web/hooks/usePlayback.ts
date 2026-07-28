"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Frames of the animation shown per second of wall clock. */
const PLAYBACK_FPS = 24;

export interface Playback {
  frame: number;
  playing: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (frame: number) => void;
}

/**
 * Steps a frame index at a fixed rate, wrapping at the end.
 *
 * ## Why the rate is fixed rather than one frame per repaint
 *
 * A run's frames are uniform in *simulation* time, so playing one per repaint
 * makes the speed depend on the display: the same shock crosses the domain in
 * half the time on a 120 Hz screen. Advancing on a clock instead means the
 * animation runs at the same speed everywhere, and a fast display simply repeats
 * frames.
 *
 * Twenty-four is enough for motion to read as motion, and low enough that the
 * plan view -- which rasterises tens of thousands of sub-triangles per repaint
 * -- can keep up alongside the surface.
 *
 * ## Why the frame lives in a ref as well as in state
 *
 * The page component holds every piece of application state, so a `setState`
 * twenty-four times a second re-renders the geometry panel, the mesh panel and
 * the histogram along with the viewport. The ref is what the animation loop
 * reads and writes; the state exists so the slider and the clock re-render, and
 * is set from the same tick. Keeping only the ref would leave the slider frozen;
 * keeping only the state would make every tick a full re-render of the page.
 */
export function usePlayback(frameCount: number): Playback {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frameRef = useRef(0);
  const countRef = useRef(frameCount);
  countRef.current = frameCount;

  // A run that is still collecting frames grows underneath the slider, and a
  // run that is replaced shrinks it. Either way the index has to stay inside.
  useEffect(() => {
    if (frameRef.current >= frameCount) {
      frameRef.current = Math.max(0, frameCount - 1);
      setFrame(frameRef.current);
    }
  }, [frameCount]);

  useEffect(() => {
    if (!playing || frameCount < 2) return;

    let handle = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const elapsed = now - last;
      const step = 1000 / PLAYBACK_FPS;

      if (elapsed >= step) {
        // Modulo rather than subtraction, so a tab that was backgrounded for a
        // second resumes at the right phase instead of racing to catch up.
        last = now - (elapsed % step);
        frameRef.current = (frameRef.current + 1) % countRef.current;
        setFrame(frameRef.current);
      }

      handle = requestAnimationFrame(tick);
    };

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, frameCount]);

  const seek = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(next, Math.max(0, countRef.current - 1)));
    frameRef.current = clamped;
    setFrame(clamped);
  }, []);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((previous) => !previous), []);

  return { frame, playing, play, pause, toggle, seek };
}
