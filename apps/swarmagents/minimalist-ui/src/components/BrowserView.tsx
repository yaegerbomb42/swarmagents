"use client";

/**
 * BrowserView — the live agent-browser screen for a run.
 *
 * Shows the latest screenshot frame for the active run (polled from
 * `/api/runtime/browser/[runId]/frame` by useBrowserFrame) inside a minimal
 * browser chrome: address bar with the run's current URL, a refresh control,
 * and a "blocked by policy" notice when a navigation was refused.
 *
 * The URL/title/dimensions and refused-navigation reasons arrive on the run's
 * SSE stream (`browser.navigated`, `browser.frame`, `browser.error` events);
 * the image bytes come from the polled frame route. Every frame-bearing event
 * bumps the polling hook's refreshKey so a new screenshot appears immediately
 * rather than waiting for the next poll tick.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Globe, Lock, RotateCcw, ShieldAlert } from "lucide-react";
import { useRunStream, type RunStreamItem } from "../../../lib/client/useRunStream";
import { useBrowserFrame } from "../../../lib/client/useBrowserFrame";
import type { Presence } from "../../../lib/client/presence";
import { cn } from "../utils/cn";

interface BrowserViewProps {
  /** Active runtime run id; when absent the view shows its idle state. */
  runId?: string;
  /**
   * The agent's current action (see lib/client/presence). When the run is
   * opening a URL the presence line already knows it, so the browser chrome
   * can name the page before the first frame lands.
   */
  presence?: Presence;
}

interface BrowserMeta {
  url?: string;
  title?: string;
  width?: number;
  height?: number;
}

interface BlockedNotice {
  reason: string;
  at: number;
}

/** How long a refused-navigation notice stays visible before auto-dismissing. */
const BLOCKED_NOTICE_MS = 10_000;

/** How long a run may sit with no frame before we say so instead of hinting. */
export const STILL_WAITING_MS = 10_000;

/** The parts of the poll state the loading indicator cares about. */
interface FrameSnapshot {
  status?: string;
  frameUrl?: string;
}

/**
 * The thin bar under the address bar is a *fetch* indicator, not a "no frame
 * yet" placeholder. The poll hook reports `polling` only while the first frame
 * fetch is outstanding; a clean 404 flips it to `empty` ("No frame yet"), and
 * a failure to `error`. Showing the bar in those settled states is what made
 * the browser look stuck, so they must never render it.
 */
export function frameFetchInFlight(runId: string | undefined, frame: FrameSnapshot): boolean {
  return Boolean(runId) && !frame.frameUrl && frame.status === "polling";
}

/** Pure 10s threshold, kept out of the timer so it can be unit-tested. */
export function hasWaitedLongEnough(idleMs: number): boolean {
  return idleMs >= STILL_WAITING_MS;
}

export interface BrowserLoadStatusProps {
  /** A frame request is genuinely in flight (no frame obtained yet). */
  fetching: boolean;
  /** The no-frame state has persisted past STILL_WAITING_MS. */
  stillWaiting: boolean;
}

/** Under-address-bar status: a real fetch gets the bar, a long idle gets text. */
export function BrowserLoadStatus({ fetching, stillWaiting }: BrowserLoadStatusProps) {
  if (fetching) {
    return (
      <div
        className="h-0.5 w-full bg-cyan-500/10 overflow-hidden shrink-0"
        role="progressbar"
        aria-label="Loading live page"
        data-testid="browser-loading-bar"
      >
        <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-pulse" />
      </div>
    );
  }
  if (stillWaiting) {
    return (
      <div
        role="status"
        data-testid="browser-still-waiting"
        className="shrink-0 border-b border-cyan-500/20 bg-cyan-500/5 px-4 py-1 text-[11px] font-mono text-cyan-300/80"
      >
        Still waiting…
      </div>
    );
  }
  return null;
}

/**
 * The live page image, crossfaded between frames: the previous frame stays
 * painted underneath until the new one has loaded, then the new one fades
 * in over 300ms. Without this the src swap flashes the empty stage on
 * every changed frame (the poller replaces the object URL whenever the
 * bytes change). The `complete` check covers a frame that decoded before
 * React attached the load handler.
 */
export function BrowserFrameImage({
  frameUrl,
  previousFrameUrl,
}: {
  frameUrl: string;
  previousFrameUrl?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [frameUrl]);
  const showPrevious = previousFrameUrl !== undefined && previousFrameUrl !== frameUrl;
  const markLoaded = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true);
  }, []);
  return (
    <div className="relative h-full w-full">
      {showPrevious && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={previousFrameUrl}
          alt=""
          aria-hidden
          draggable={false}
          data-testid="browser-frame-previous"
          className="absolute left-1/2 top-1/2 max-h-full max-w-full -translate-x-1/2 -translate-y-1/2 object-contain"
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={markLoaded}
        src={frameUrl}
        alt="Live page"
        draggable={false}
        onLoad={() => setLoaded(true)}
        data-testid="browser-frame-current"
        className={cn(
          "absolute left-1/2 top-1/2 max-h-full max-w-full -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/10 object-contain shadow-2xl transition-opacity duration-300 select-none",
          loaded || !showPrevious ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

/** A run's frame-bearing SSE events carry their metadata under `data`. */
function frameMeta(item: RunStreamItem): BrowserMeta | null {
  const payload = item.data as { data?: Partial<BrowserMeta> } | null;
  const meta = payload?.data;
  if (!meta || typeof meta !== "object") return null;
  return meta;
}

/** Human-friendly age of the last frame fetch ("8s ago", "2m ago"). */
function timeAgo(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function EmptyState({ hasRun, error }: { hasRun: boolean; error?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 text-center max-w-md">
      <div className="relative" aria-hidden="true">
        <div className="absolute inset-0 rounded-full bg-cyan-500/10 blur-2xl" />
        <div className="relative w-28 h-24 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02] p-2 shadow-2xl">
          <div className="flex items-center gap-1 pb-1.5 border-b border-white/10">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400/60" />
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/60" />
            <span className="ml-auto h-1.5 w-10 rounded-full bg-white/10" />
          </div>
          <div className="h-[calc(100%-0.75rem)] grid place-items-center text-cyan-400/80">
            <Globe className="w-7 h-7" />
          </div>
        </div>
      </div>
      {error ? (
        <>
          <div className="text-sm font-medium text-amber-300/90">Page view unavailable</div>
          <p className="text-xs text-white/40 leading-relaxed">
            We couldn’t show the page ({error}). Trying again…
          </p>
        </>
      ) : hasRun ? (
        <>
          <div className="text-sm font-medium text-white/90">No page yet</div>
          <p className="text-xs text-white/40 leading-relaxed">
            The desktop frame appears once a run opens a page.
          </p>
        </>
      ) : (
        <>
          <div className="text-sm font-medium text-white/90">Waiting for a run</div>
          <p className="text-xs text-white/40 leading-relaxed">
            The desktop frame appears once a run opens a page. Start a run to begin.
          </p>
        </>
      )}
    </div>
  );
}

export function BrowserView({ runId, presence }: BrowserViewProps) {
  const stream = useRunStream(runId);

  // Frame-bearing events force an immediate refetch (refreshKey bump). The
  // count is monotonic even when the SSE list prunes old items (MAX_LINES),
  // so a new frame event always differs from the previous refreshKey.
  const frameEventsRef = useRef(0);
  const frameEvents = stream.items.filter(
    (item) => item.kind === "browser.frame" || item.kind === "browser.navigated",
  ).length;
  if (frameEvents > frameEventsRef.current) frameEventsRef.current = frameEvents;
  const refreshKey = frameEventsRef.current;
  const frame = useBrowserFrame(runId, { refreshKey });

  const [meta, setMeta] = useState<BrowserMeta>({});
  const [blocked, setBlocked] = useState<BlockedNotice>();
  const [draft, setDraft] = useState("");
  const [navBusy, setNavBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const blockedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Tick once a second so the "last updated" caption stays current.
  useEffect(() => {
    if (!frame.fetchedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [frame.fetchedAt]);

  const presenceUrl = presence?.action?.startsWith("Opening ")
    ? presence.action.slice("Opening ".length)
    : undefined;
  const currentUrl = meta.url ?? (draft || presenceUrl || "");
  const secure = currentUrl.startsWith("https://");
  // A run with no frame yet (and no hard error) is the state that can look
  // stuck. Time it so the fetch hint can give way to an honest "Still waiting…".
  const noFrameYet = Boolean(runId) && !frame.frameUrl && frame.status !== "error";
  const [waitMs, setWaitMs] = useState(0);
  useEffect(() => {
    setWaitMs(0);
    if (!noFrameYet) return;
    const started = Date.now();
    const timer = setInterval(() => setWaitMs(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [runId, noFrameYet]);
  const stillWaiting = noFrameYet && hasWaitedLongEnough(waitMs);
  const fetching = frameFetchInFlight(runId, frame);

  // Follow the run stream: current URL/title/dimensions, and refused
  // navigations (browser.error with action "navigate").
  useEffect(() => {
    if (!runId) {
      setMeta({});
      setBlocked(undefined);
      setDraft("");
      return;
    }
    let latestMeta: BrowserMeta = {};
    let latestBlocked: BlockedNotice | undefined;
    for (const item of stream.items) {
      if (item.kind === "browser.navigated" || item.kind === "browser.frame") {
        const m = frameMeta(item);
        if (m) latestMeta = { ...latestMeta, ...m };
        // A successful navigation clears any outstanding blocked notice.
        if (item.kind === "browser.navigated") latestBlocked = undefined;
      } else if (item.kind === "browser.error") {
        const payload = item.data as { data?: { action?: string; reason?: string; url?: string } } | null;
        if (payload?.data?.action === "navigate" && payload.data.reason) {
          latestBlocked = { reason: payload.data.reason, at: Date.now() };
        }
      }
    }
    if (latestMeta.url !== undefined) {
      setMeta(latestMeta);
      setDraft((cur) => (cur === "" ? latestMeta.url! : cur));
    }
    if (latestBlocked !== undefined) {
      setBlocked(latestBlocked);
    }
  }, [runId, stream.items]);

  // Auto-dismiss the blocked notice after a while.
  useEffect(() => {
    if (!blocked) return;
    blockedTimerRef.current = setTimeout(() => setBlocked(undefined), BLOCKED_NOTICE_MS);
    return () => {
      if (blockedTimerRef.current) clearTimeout(blockedTimerRef.current);
    };
  }, [blocked]);

  const navigate = useCallback(
    async (raw: string) => {
      const url = raw.trim();
      if (!url || !runId || navBusy) return;
      setNavBusy(true);
      try {
        const res = await fetch(`/api/runtime/browser/${encodeURIComponent(runId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
        if (res.ok) {
          const finalUrl = data?.url ?? url;
          setDraft(finalUrl);
          setBlocked(undefined);
        } else {
          // The server refuses policy violations (and load failures) with a
          // 400; surface the reason as a "blocked by policy" notice.
          setBlocked({ reason: data?.error ?? `navigation failed (${res.status})`, at: Date.now() });
        }
      } catch {
        setBlocked({ reason: "Could not reach the runtime.", at: Date.now() });
      } finally {
        setNavBusy(false);
      }
    },
    [runId, navBusy],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void navigate(draft);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Browser chrome */}
      <div className="bg-[#121218] border-b border-white/10 px-4 py-2 flex items-center gap-3">
        <button
          onClick={frame.refresh}
          disabled={!runId}
          title="Refresh frame"
          className="text-white/40 hover:text-white disabled:opacity-30 transition"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>

        <div className="flex-1 bg-black/60 border border-white/10 rounded-xl px-3 py-1 text-[11px] font-mono text-white/70 flex items-center gap-2 min-w-0 focus-within:border-cyan-500/40 transition-colors">
          {blocked ? (
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 text-rose-400" aria-label="Navigation blocked" />
          ) : secure ? (
            <Lock className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-label="Secure connection" />
          ) : (
            <Globe className="w-3.5 h-3.5 shrink-0 text-white/35" aria-label="Address" />
          )}
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={runId ? "https://…" : "start a run to open a page"}
            disabled={!runId || navBusy}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label="Address bar"
            className="bg-transparent border-none focus:outline-none w-full text-white/90 placeholder:text-white/25"
          />
        </div>

        <button
          onClick={() => void navigate(draft)}
          disabled={!runId || navBusy || !draft.trim()}
          title="Navigate"
          className="text-white/50 hover:text-cyan-300 disabled:opacity-30 transition"
        >
          <ArrowRight className="w-4 h-4" />
        </button>

        {frame.fetchedAt ? (
          <span className="text-[10px] font-mono text-white/35 shrink-0 hidden sm:inline">
            last updated {timeAgo(frame.fetchedAt, now)}
          </span>
        ) : null}

        {meta.width && meta.height ? (
          <span className="text-[10px] font-mono text-white/40 bg-white/5 px-2 py-0.5 rounded-full shrink-0">
            {meta.width}×{meta.height}
          </span>
        ) : null}
      </div>

      {/* Thin bar only while a frame is actually being fetched; after a long
          wait with no frame, say so instead of showing a stuck-looking bar. */}
      <BrowserLoadStatus fetching={fetching} stillWaiting={stillWaiting} />

      {/* Refused navigation notice */}
      {blocked ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 px-4 py-2.5 border-b border-rose-500/30 bg-rose-950/50 border-l-2 border-l-rose-500 text-rose-200"
        >
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0 text-rose-400" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-rose-300">
              This address was blocked
            </div>
            <p className="text-[11px] text-rose-200/70 font-mono break-words leading-relaxed">
              {blocked.reason}
            </p>
          </div>
          <button
            onClick={() => setBlocked(undefined)}
            className="text-rose-300/60 hover:text-rose-100 text-[10px] uppercase tracking-wide shrink-0 mt-0.5 transition-colors"
          >
            dismiss
          </button>
        </div>
      ) : null}

      {/* Browser viewport */}
      <div className="flex-1 min-h-0 grid place-items-center bg-[#07070a] p-6 overflow-hidden">
        {frame.frameUrl ? (
          <BrowserFrameImage frameUrl={frame.frameUrl} previousFrameUrl={frame.previousFrameUrl} />
        ) : (
          <EmptyState hasRun={Boolean(runId)} error={frame.status === "error" ? frame.error : undefined} />
        )}
      </div>
    </div>
  );
}
