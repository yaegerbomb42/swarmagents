"use client";

/**
 * useStickToBottom(contentVersion) — keep a scrollable log pinned to the
 * bottom while new output streams in.
 *
 * The terminal (ComputerScreen) renders a live SSE stream: shell output,
 * tool results and the final `run.finished` line all append to the same
 * scrollable pane. Without this, the viewport stays wherever it was when
 * the run started, so the separator and the final result sit below the fold
 * after the run ends (q5: the make-a-file run finished at exit 0 while the
 * viewport still showed the middle of the `ls` output).
 *
 * Behaviour:
 *   - While the user is at (or near) the bottom, every content change
 *     scrolls the pane to the bottom — during streaming and after the run
 *     ends, since the finished line is just another appended row.
 *   - Once the user scrolls up past the threshold, sticking pauses and the
 *     caller shows a "Jump to latest" button (`stuck === false`). Clicking
 *     it (`jumpToLatest`) scrolls to the bottom and re-engages sticking.
 *   - A run that produces no new rows (empty stream) never scrolls, so the
 *     empty state stays put.
 *
 * The geometry is extracted into the pure helpers below so the
 * stick-to-bottom decision can be unit-tested without a DOM; the hook only
 * owns the scroll listener and the scrollTop side effect.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How close to the bottom counts as "at the bottom". A small slack absorbs
 * sub-pixel rounding and one-line overshoot so the pane does not unstick
 * over a fraction of a pixel.
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 24;

/** The scroll geometry the helpers read — a real element or a test double. */
export interface ScrollGeometry {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/**
 * True when the viewport is at (or within `thresholdPx` of) the bottom of
 * the scrollable content — i.e. the user has not scrolled up to read older
 * output. Content shorter than the viewport is always "at the bottom".
 */
export function isNearBottom(
  el: ScrollGeometry,
  thresholdPx: number = STICK_TO_BOTTOM_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}

/**
 * Whether the pane is still following the latest content after a scroll
 * event. Reaching the bottom follows; moving up, away from the bottom, stops.
 *
 * A scroll event that finds the bottom further away without the viewport
 * having moved up is content growing under a pane that was following: the
 * event for our own scroll arrives after the next rows have rendered. It
 * changes nothing. Reading it as "the user scrolled away" stopped the pane
 * following at the moment new content arrived, leaving it below the fold.
 */
export function stuckAfterScroll(
  wasStuck: boolean,
  previousScrollTop: number,
  el: ScrollGeometry,
  thresholdPx: number = STICK_TO_BOTTOM_THRESHOLD_PX,
): boolean {
  if (isNearBottom(el, thresholdPx)) return true;
  if (el.scrollTop < previousScrollTop) return false;
  return wasStuck;
}

/**
 * How long after the reader opens or closes a section the pane re-reads where
 * they are instead of moving them (the section may still be loading).
 */
export const READER_HOLD_MS = 500;

/** Pin the viewport to the last line of content. */
export function scrollElementToBottom(el: { scrollTop: number; scrollHeight: number }): void {
  el.scrollTop = el.scrollHeight;
}

export interface StickToBottom {
  /** Attach to the scrollable pane. */
  ref: React.RefObject<HTMLDivElement | null>;
  /** False once the user has scrolled up — show the "Jump to latest" button. */
  stuck: boolean;
  /** Attach to the pane's onScroll. */
  onScroll: () => void;
  /** Scroll to the bottom and re-engage sticking. */
  jumpToLatest: () => void;
  /**
   * Optional: attach to the element that wraps the pane's content. The pane
   * then also follows height changes that add no row (a section loads, the
   * pane itself gets shorter), not only `contentVersion`.
   */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /**
   * The reader opened or closed a section. For a moment the pane re-reads
   * where they are instead of scrolling, so what they opened stays put.
   */
  hold: () => void;
}

/**
 * Track a scrollable pane and pin it to the bottom on every content change
 * while the user is at the bottom. `contentVersion` should change whenever
 * a row is added or removed (e.g. the stream item count); the effect only
 * scrolls when the pane is currently stuck, so scrolled-up reading is never
 * yanked away.
 */
export function useStickToBottom(contentVersion: number): StickToBottom {
  const ref = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(true);
  // Mirror in a ref so the scroll effect reads the current value without
  // re-running on every scroll event (which would scroll while reading).
  const stuckRef = useRef(true);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTop = useRef(0);
  const heldUntil = useRef(0);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = stuckAfterScroll(stuckRef.current, lastScrollTop.current, el);
    lastScrollTop.current = el.scrollTop;
    stuckRef.current = next;
    setStuck(next);
  }, []);

  const hold = useCallback(() => {
    heldUntil.current = Date.now() + READER_HOLD_MS;
  }, []);

  // Follow height changes that add no row. Only when the caller attached
  // `contentRef`; the observer runs after layout and before paint, so the
  // reader never sees the frame in between.
  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (Date.now() < heldUntil.current) {
        const near = isNearBottom(el);
        stuckRef.current = near;
        setStuck(near);
        return;
      }
      if (stuckRef.current) scrollElementToBottom(el);
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && stuckRef.current) {
      scrollElementToBottom(el);
    }
  }, [contentVersion]);

  const jumpToLatest = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    scrollElementToBottom(el);
    stuckRef.current = true;
    setStuck(true);
  }, []);

  return { ref, stuck, onScroll, jumpToLatest, contentRef, hold };
}
