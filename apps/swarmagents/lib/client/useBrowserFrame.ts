"use client";

/**
 * useBrowserFrame(runId) — poll the latest screenshot frame for a run.
 *
 * The runtime serves frames as JPEG bytes at
 * `/api/runtime/browser/[runId]/frame`. This hook fetches that route at a
 * modest, steady rate while the tab is visible:
 *
 *   - 200 (image/jpeg): the frame is replaced when its byte size changed
 *     since the last fetch, or when `refreshKey` advanced (the caller bumps it
 *     when a `browser.frame` / `browser.navigated` SSE event says a new frame
 *     exists). Same-size frames keep the previous object URL so the <img>
 *     does not flicker on every tick.
 *   - 404: no frame captured yet — an empty state, not an error. Polling
 *     continues at the base interval.
 *   - any other failure: keep the last good frame and back off exponentially
 *     (base = interval, doubling, capped), so a flapping backend is not
 *     hammered. The backoff resets on the next successful fetch.
 *
 * Polling pauses while the document is hidden (`visibilitychange`) and resumes
 * immediately the next time the tab becomes visible. When `runId` is absent
 * the hook stays idle.
 *
 * The scheduling policy is extracted into the pure helpers at the bottom of
 * this module so the timing logic can be unit-tested without timers or a DOM.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { backoffDelayMs } from "./backoff";

export const BROWSER_POLL_INTERVAL_MS = 1000;
export const BROWSER_POLL_MAX_BACKOFF_MS = 15_000;

/** A run's latest frame is served at /api/runtime/browser/[runId]/frame. */
export function browserFrameUrl(runId: string): string {
  return `/api/runtime/browser/${encodeURIComponent(runId)}/frame`;
}

export interface BrowserPollOptions {
  /** Delay between successful polls (default 1000ms). */
  intervalMs?: number;
  /** Ceiling for the failure backoff (default 15s). */
  maxBackoffMs?: number;
}

/** Mutable state of one poll loop, folded by the pure helpers below. */
export interface BrowserPollState {
  /** Consecutive failed ticks (fetch error / non-404 HTTP error). */
  failStreak: number;
}

export function initialBrowserPollState(): BrowserPollState {
  return { failStreak: 0 };
}

/**
 * Fold the outcome of one tick into the poll state. Success — and the 404
 * "no frame yet" case — reset the failure streak; anything else increments it.
 */
export function recordBrowserPollOutcome(state: BrowserPollState, ok: boolean): BrowserPollState {
  return ok ? initialBrowserPollState() : { failStreak: state.failStreak + 1 };
}

/**
 * Delay until the next poll tick after a tick that finished with `ok`.
 * Success polls at the base interval; a failure backs off exponentially from
 * the interval, capped at `maxBackoffMs`, so a down server is probed at most
 * every ~15s instead of every second.
 */
export function nextBrowserPollDelayMs(state: BrowserPollState, options: BrowserPollOptions = {}): number {
  const intervalMs = options.intervalMs ?? BROWSER_POLL_INTERVAL_MS;
  const maxBackoffMs = Math.max(intervalMs, options.maxBackoffMs ?? BROWSER_POLL_MAX_BACKOFF_MS);
  if (state.failStreak <= 0) return intervalMs;
  return backoffDelayMs(state.failStreak - 1, { baseMs: intervalMs, maxMs: maxBackoffMs });
}

/**
 * The delay schedule a poll loop would produce for a given script of outcomes
 * ("ok" = successful fetch or clean 404; "fail" = network/HTTP error). Pure,
 * deterministic, and the unit-tested core of the hook's timing.
 */
export function browserPollSchedule(outcomes: readonly ("ok" | "fail")[], options: BrowserPollOptions = {}): number[] {
  let state = initialBrowserPollState();
  return outcomes.map((outcome) => {
    const delay = nextBrowserPollDelayMs(state, options);
    state = recordBrowserPollOutcome(state, outcome === "ok");
    return delay;
  });
}

export type BrowserFrameStatus = "idle" | "polling" | "empty" | "error";

export interface BrowserFrameState {
  /** "idle" (no run), "polling" (run active), "empty" (no frame yet), "error". */
  status: BrowserFrameStatus;
  /** Object URL of the latest frame; replaced on update, revoked on unmount. */
  frameUrl?: string;
  /**
   * Object URL of the frame the current one replaced. Kept alive (not
   * revoked) so the view can crossfade between frames instead of flashing
   * the empty stage on every changed frame; revoked when the next frame
   * supersedes it. Never set when there is no current frame.
   */
  previousFrameUrl?: string;
  /** Epoch ms the frame bytes were last fetched. */
  fetchedAt?: number;
  /** Last fetch error message, when status === "error". */
  error?: string;
}

/**
 * Pure rotation for the frame crossfade: the new frame becomes current, the
 * just-superseded frame becomes previous (kept alive so the view can fade
 * between them), and the older previous — if any — is the one to revoke.
 * Only one stale object URL is ever kept alive.
 */
export function rotateFrameUrls(
  current: string | undefined,
  previous: string | undefined,
  next: string,
): { frameUrl: string; previousFrameUrl?: string; revoke?: string } {
  return { frameUrl: next, previousFrameUrl: current, revoke: previous };
}

interface InternalState extends BrowserFrameState {
  frameSize?: number;
}

export interface BrowserFrameHookOptions extends BrowserPollOptions {
  /** Bump when a frame-bearing stream event arrives to force a refresh. */
  refreshKey?: number;
  /** Injectable visibility check (tests); defaults to document.visibilityState. */
  isVisible?: () => boolean;
}

export function useBrowserFrame(runId?: string | null, options: BrowserFrameHookOptions = {}): BrowserFrameState & { refresh: () => void } {
  const { intervalMs, maxBackoffMs, refreshKey = 0, isVisible } = options;

  const [state, setState] = useState<InternalState>({ status: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const urlRef = useRef<string | undefined>(undefined);
  /** The previous frame's object URL, kept alive for the crossfade. */
  const prevUrlRef = useRef<string | undefined>(undefined);
  const prevRunIdRef = useRef<string | null | undefined>(null);
  /** Bumped to restart the loop immediately (manual refresh or refreshKey). */
  const [signal, setSignal] = useState(0);

  const visible = useCallback(() => {
    if (isVisible) return isVisible();
    return typeof document === "undefined" ? true : document.visibilityState === "visible";
  }, [isVisible]);

  // A frame-bearing SSE event (or a manual refresh) restarts the loop, which
  // fetches immediately instead of waiting for the next scheduled tick. The
  // ref skips the initial mount so mounting does not double-start the loop.
  const prevRefreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (prevRefreshKeyRef.current !== refreshKey) {
      prevRefreshKeyRef.current = refreshKey;
      setSignal((s) => s + 1);
    }
  }, [refreshKey]);

  const refresh = useCallback(() => setSignal((s) => s + 1), []);

  useEffect(() => {
    // When the run changes (or clears), drop the previous run's frame before
    // fetching anything, so a stale image never flashes for the new run. On a
    // pure refresh signal (same runId) the current frame stays until the new
    // bytes arrive.
    const id = runId ?? null;
    if (id !== prevRunIdRef.current) {
      prevRunIdRef.current = id;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = undefined;
      }
      if (prevUrlRef.current) {
        URL.revokeObjectURL(prevUrlRef.current);
        prevUrlRef.current = undefined;
      }
      setState({ status: id ? "polling" : "idle" });
      if (!id) return;
    }
    // The run stayed cleared (e.g. refresh clicked while idle): stay idle.
    if (!id) return;

    const aborter = new AbortController();
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollState = initialBrowserPollState();

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    const replaceFrame = (blob: Blob) => {
      const next = URL.createObjectURL(blob);
      const rotated = rotateFrameUrls(urlRef.current, prevUrlRef.current, next);
      if (rotated.revoke) URL.revokeObjectURL(rotated.revoke);
      prevUrlRef.current = rotated.previousFrameUrl;
      urlRef.current = next;
      setState({
        status: "polling",
        frameUrl: next,
        previousFrameUrl: rotated.previousFrameUrl,
        frameSize: blob.size,
        fetchedAt: Date.now(),
      });
    };

    const schedule = (delayMs: number) => {
      if (!alive) return;
      clearTimer();
      timer = setTimeout(() => void tick(false), delayMs);
    };

    // `force` replaces the frame even when its size is unchanged (initial
    // fetch, manual refresh, or a stream event announcing a new frame).
    const tick = async (force: boolean) => {
      if (!alive) return;
      // Pause while hidden: no fetch, no timer. The visibilitychange listener
      // below resumes the loop the moment the tab becomes visible again.
      if (!visible()) return;
      try {
        const res = await fetch(browserFrameUrl(id), {
          cache: "no-store",
          signal: aborter.signal,
        });
        if (!alive) return;
        if (res.status === 200) {
          const blob = await res.blob();
          if (!alive) return;
          pollState = recordBrowserPollOutcome(pollState, true);
          const prev = stateRef.current;
          if (prev.frameSize === blob.size && !force) {
            // Same bytes as the last fetch (a quiet page): keep the current
            // object URL so the <img> does not remount, just re-arm the timer.
            schedule(nextBrowserPollDelayMs(pollState, { intervalMs, maxBackoffMs }));
            return;
          }
          replaceFrame(blob);
          schedule(nextBrowserPollDelayMs(pollState, { intervalMs, maxBackoffMs }));
        } else if (res.status === 404) {
          // No frame captured yet — a legitimate empty state, not an error.
          pollState = recordBrowserPollOutcome(pollState, true);
          if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
            urlRef.current = undefined;
          }
          if (prevUrlRef.current) {
            URL.revokeObjectURL(prevUrlRef.current);
            prevUrlRef.current = undefined;
          }
          setState({ status: "empty" });
          schedule(nextBrowserPollDelayMs(pollState, { intervalMs, maxBackoffMs }));
        } else {
          throw new Error(`browser frame responded ${res.status}`);
        }
      } catch (err) {
        if (!alive || aborter.signal.aborted) return;
        pollState = recordBrowserPollOutcome(pollState, false);
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, status: "error", error: message }));
        schedule(nextBrowserPollDelayMs(pollState, { intervalMs, maxBackoffMs }));
      }
    };

    const onVisibility = () => {
      // Resume immediately on becoming visible; a hidden tab stays paused.
      if (visible()) void tick(true);
    };

    void tick(true);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      clearTimer();
      aborter.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `signal` restarts the loop (refreshKey events and manual refreshes);
    // runId changes restart it for a new run.
  }, [runId, signal, visible, intervalMs, maxBackoffMs]);

  // Revoke the latest object URL on unmount (guard against stale URLs from a
  // previous runId).
  useEffect(() => {
    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = undefined;
      }
      if (prevUrlRef.current) {
        URL.revokeObjectURL(prevUrlRef.current);
        prevUrlRef.current = undefined;
      }
    };
  }, []);

  return { ...state, refresh };
}
