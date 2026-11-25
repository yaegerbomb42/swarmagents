/**
 * vm-tokens.ts — the one visual language of the computer screen.
 *
 * The four VM views (desktop, terminal, browser, files) used to be four
 * widgets: a Mac-dot titlebar here, a browser-styled address bar there, a
 * workspace listing with its own accent color. This module is the single
 * source of truth they all read now, so the surfaces cannot drift apart:
 *
 *   - SURFACE      the stage background, the well inside it, the hairline
 *   - CHROME       the top bar and the status bar (same height, same border)
 *   - TONE         dot + word colors for every status the screen shows
 *   - VIEW_ACCENT  the one tint each view is allowed to use for *content*,
 *                  never for chrome: the chrome is always the same graphite
 *   - MOTION       the timings used by the presence glow and the idle fade
 *
 * Values come from app/globals.css's `--color-sa-*` tokens (the workspace
 * language: graphite surface, indigo = you can act, green/amber/rose = status
 * only). Keeping them as Tailwind class strings here — rather than inline
 * styles — means the classes are statically present for Tailwind to compile.
 *
 * Plain data, no JSX, no DOM: unit-tested in vm-tokens.test.ts.
 */

import type { StatusTone } from "../../../lib/client/runPhase";

/* ── Surfaces ────────────────────────────────────────────────────────────── */

/** The stage: what the views are painted on. One black, everywhere. */
export const SURFACE = {
  /** Outer frame of the screen (behind the chrome). */
  stage: "bg-[#090e1c]/80 backdrop-blur-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_24px_60px_-24px_rgba(0,0,0,0.85)]",
  /** The well inside the chrome: the viewport each view fills. */
  well: "bg-[#060913]/90",
  /** Raised strips inside the well (a browser address bar, a file preview head). */
  raised: "bg-[#121a30]/80 backdrop-blur-md",
  /** Hairline between chrome and content. */
  line: "border-white/[0.09]",
  /** The desktop stage keeps pure black so the noVNC pixels are never tinted. */
  desktop: "bg-black",
} as const;

/* ── Chrome ──────────────────────────────────────────────────────────────── */

/**
 * The chrome all four views share. Both bars are 36px so switching views never
 * shifts the stage; the tab pill, the status cluster and the controls are the
 * same heights in every view.
 */
export const CHROME = {
  /** The one top bar: view tabs, presence, controls. */
  bar: "flex h-9 shrink-0 items-center gap-2 border-b px-2",
  barLook: "border-white/[0.09] bg-white/[0.03] backdrop-blur-xl",
  /** The one status bar under the stage: VM, run, connection, presence. */
  statusBar: "flex h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-2.5 text-[11px]",
  statusBarLook: "border-white/[0.09] bg-white/[0.03] backdrop-blur-xl",
  /** The view switcher: one pill group, identical in every view. */
  tabGroup: "inline-flex h-7 shrink-0 items-center gap-0.5 rounded-xl border border-white/[0.09] bg-black/35 p-0.5 shadow-[inset_0_1px_3px_rgba(0,0,0,0.5)]",
  tab: "inline-flex h-6 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sa-accent-fg/60",
  tabActive: "bg-white/[0.12] text-sa-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_2px_8px_-2px_rgba(0,0,0,0.6)]",
  tabIdle: "text-sa-fg3 hover:bg-white/[0.05] hover:text-sa-fg2",
  /** Small icon-only control in the bar. */
  iconButton:
    "grid h-6 w-6 shrink-0 place-items-center rounded-md text-sa-fg3 transition-colors hover:bg-white/5 hover:text-sa-fg disabled:cursor-not-allowed disabled:opacity-40",
} as const;

/* ── Status tones ────────────────────────────────────────────────────────── */

/**
 * One tone vocabulary for the status bar. Same five tones as runPhase.ts, so
 * "running" in the conversation and "running" in the status bar are the same
 * color. `dot` is the 5px status light; `text` is the word beside it.
 */
export const TONE: Record<StatusTone, { dot: string; text: string; pill: string }> = {
  accent: {
    dot: "bg-sa-accent-fg",
    text: "text-sa-accent-fg",
    pill: "border-sa-accent/40 bg-sa-accent/10 text-sa-accent-fg",
  },
  ok: {
    dot: "bg-sa-ok",
    text: "text-sa-ok",
    pill: "border-sa-ok/30 bg-sa-ok/10 text-sa-ok",
  },
  warn: {
    dot: "bg-sa-warn",
    text: "text-sa-warn",
    pill: "border-sa-warn/30 bg-sa-warn/10 text-sa-warn",
  },
  err: {
    dot: "bg-sa-err",
    text: "text-sa-err",
    pill: "border-sa-err/30 bg-sa-err/10 text-sa-err",
  },
  muted: {
    dot: "bg-sa-fg3",
    text: "text-sa-fg3",
    pill: "border-sa-line bg-white/[0.03] text-sa-fg2",
  },
};

/* ── Per-view accents ────────────────────────────────────────────────────── */

/**
 * Each view owns exactly one content tint. The chrome never takes these: a
 * terminal prompt is emerald, a link is sky, a folder is amber — but the bar
 * above them stays graphite in all four views.
 */
export const VIEW_ACCENT = {
  desktop: { key: "text-sa-fg2", ring: "ring-white/10" },
  terminal: { key: "text-emerald-300", ring: "ring-emerald-400/20" },
  browser: { key: "text-sky-300", ring: "ring-sky-400/20" },
  files: { key: "text-amber-300", ring: "ring-amber-400/20" },
} as const;

/* ── Motion ──────────────────────────────────────────────────────────────── */

/**
 * Motion marks state changes only. The idle fade is long enough to read as
 * "the chrome stepped back", short enough that a mouse twitch brings it back
 * before the user notices a delay.
 */
export const MOTION = {
  /** Desktop chrome fades after this much pointer/keyboard silence. */
  idleAfterMs: 3200,
  /** A changed file keeps its presence highlight this long. */
  changedFlashMs: 2600,
  /** CSS transition for chrome opacity (also the reduced-motion duration). */
  chromeFade: "transition-opacity duration-500 ease-out",
} as const;

/* ── Formatting helpers (pure) ───────────────────────────────────────────── */

/** "1 tool · 2 files" style counts; omits zero parts. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "just now", "12s ago", "3m ago" — the presence line's freshness stamp. */
export function freshness(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 1000) return "just now";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * The short path a status bar shows: the workspace-relative tail, capped so a
 * deep path never pushes the rest of the bar off the line.
 */
export function shortPath(path: string | undefined, root = "/workspace", maxSegments = 3): string {
  if (!path) return "";
  const relative = path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  if (!relative) return "workspace";
  const segments = relative.split("/").filter(Boolean);
  if (segments.length <= maxSegments) return segments.join("/");
  return `…/${segments.slice(-maxSegments).join("/")}`;
}
