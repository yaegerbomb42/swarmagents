import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { BROWSER_PROFILE, ROOT } from "../store";

// ═══════ Browser runtime ═══════
//
// One isolated Chromium context per task key, each with its own persistent profile and
// downloads folder, hard resource limits, crash reaping and resume-after-restart.
//
// This module is server-only (playwright-core is a serverExternalPackage). The UI never
// imports it: the live viewer talks to app/api/browser/* over HTTP.

/** Hard caps for one browser session. Everything is overridable with SWARM_BROWSER_*. */
export interface BrowserLimits {
  /** Max tabs (pages) inside one session. New tabs beyond this fail fast. */
  maxTabs: number;
  /** Max total bytes downloaded across the session. */
  maxDownloadBytes: number;
  /** Max bytes for a single downloaded file. */
  maxDownloadFileBytes: number;
  /** Wall-clock cap for the whole session (ms). 0 = no cap. */
  wallMs: number;
  /** Close an idle session after this long (ms). 0 = no cap. */
  idleMs: number;
  /** Largest number of live sessions kept before the least-recently-used idle one is reaped. */
  maxLive: number;
  viewport: { width: number; height: number };
  /** Download filename extensions we accept. Anything else is discarded. */
  downloadTypes: RegExp;
}

/** Live pointer onto the page the agent (or the user, during take-over) is driving. */
export interface BrowserPointer {
  x: number;
  y: number;
  label?: string;
}

/** What the viewer needs to know about a session without subscribing to frames. */
export interface BrowserStatus {
  key: string;
  live: boolean;
  controller: "agent" | "user";
  paused: boolean;
  url: string;
  title: string;
  tabs: { index: number; url: string; title: string; active: boolean }[];
  pointer: BrowserPointer | null;
  downloads: { name: string; bytes: number; path: string; at: number }[];
  startedAt: number;
  lastActiveAt: number;
  frames: number;
  /** Set when the session stopped for a reason (limit, crash, stop). */
  note?: string;
}

export type BrowserEvent =
  | { type: "action"; ts: number; key: string; action: string; detail?: string; ok: boolean }
  | { type: "download"; ts: number; key: string; name: string; bytes: number; path: string; blocked?: string }
  | { type: "tab"; ts: number; key: string; index: number; count: number; url: string }
  | { type: "control"; ts: number; key: string; controller: "agent" | "user"; paused: boolean }
  | { type: "notice"; ts: number; key: string; text: string; level: "info" | "warn" | "error" }
  | { type: "closed"; ts: number; key: string; reason: string };

export interface ScreencastFrame {
  /** base64 JPEG, no data: prefix. */
  data: string;
  /** Frame timestamp in ms (CDP metadata). */
  ts: number;
  /** Scroll offset of the frame (CDP metadata), used to map viewer coords -> page coords. */
  offsetTop: number;
  /** 1-based monotonically increasing frame counter for the session. */
  n: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export const DEFAULT_LIMITS: BrowserLimits = {
  maxTabs: num(process.env.SWARM_BROWSER_MAX_TABS, 12),
  maxDownloadBytes: num(process.env.SWARM_BROWSER_MAX_DOWNLOAD_BYTES, 512 * 1024 * 1024),
  maxDownloadFileBytes: num(process.env.SWARM_BROWSER_MAX_FILE_BYTES, 256 * 1024 * 1024),
  wallMs: num(process.env.SWARM_BROWSER_MAX_SESSION_MS, 60 * 60 * 1000),
  idleMs: num(process.env.SWARM_BROWSER_IDLE_MS, 15 * 60 * 1000),
  maxLive: num(process.env.SWARM_BROWSER_MAX_LIVE, 4),
  viewport: { width: 1280, height: 860 },
  downloadTypes: /\.(pdf|txt|csv|tsv|json|xml|html?|md|log|zip|gz|tar|xlsx?|docx?|pptx?|png|jpe?g|gif|webp|svg|mp3|mp4|wav|avif)$/i,
};

/** Filesystem slug for a task key: stable, collision-resistant, safe for a directory name. */
export function keySlug(key: string) {
  const clean = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "session";
  return `${clean}-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

const headless = () =>
  process.env.SWARM_BROWSER_HEADLESS === "1" ||
  (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

/** Chrome gets no server secrets: drop SWARM_* and anything credential-shaped. */
function browserEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("SWARM_") && !/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(k)) env[k] = v;
  return env;
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;