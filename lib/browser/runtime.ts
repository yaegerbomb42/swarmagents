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

function uniquePath(dir: string, name: string) {
  const safe = (name || "download").replace(/[/\\:\0]/g, "_").slice(0, 180);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let file = path.join(dir, safe);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${stem} (${i})${ext}`);
  return file;
}

/** One isolated browser session: its own Chromium context, profile, downloads and limits. */
export class BrowserSession {
  readonly key: string;
  readonly dir: string;
  readonly downloadsDir: string;
  readonly limits: BrowserLimits;
  readonly startedAt = Date.now();
  lastActiveAt = Date.now();
  controller: "agent" | "user" = "agent";
  paused = false;
  note?: string;
  pointer: BrowserPointer | null = null;
  frames = 0;

  private ctx: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private active: Page | null = null;
  private cdp: CDPSession | null = null;
  private frameSubs = new Set<(f: ScreencastFrame) => void>();
  private eventSubs = new Set<(e: BrowserEvent) => void>();
  private recent: string[] = [];
  private downloadList: { name: string; bytes: number; path: string; at: number }[] = [];
  private downloadedBytes = 0;
  private pendingDownloads = new Set<Promise<void>>();
  private screencastOn = false;
  private closed = false;
  private waiters = new Set<() => void>();
  private watched = new WeakSet<Page>();

  constructor(key: string, limits: BrowserLimits = DEFAULT_LIMITS, root = path.join(ROOT, "browsers")) {
    this.key = key;
    this.limits = limits;
    this.dir = path.join(root, keySlug(key));
    this.downloadsDir = path.join(this.dir, "downloads");
  }

  // ---- events ----

  private emitSpec(e: BrowserEvent) {
    for (const cb of this.eventSubs) {
      try {
        cb(e);
      } catch {}
    }
  }

  emit(e: BrowserEvent) {
    this.emitSpec(e);
  }

  /** A human-readable happening (download, dialog, popup) surfaced with the next observation. */
  log(text: string) {
    this.recent.push(text);
    if (this.recent.length > 50) this.recent.shift();
  }

  /** Take (and clear) the happenings since the last call. */
  drainNotes() {
    return this.recent.splice(0);
  }

  onFrame(cb: (f: ScreencastFrame) => void) {
    this.frameSubs.add(cb);
    if (this.screencastOn) void this.startScreencast();
    return () => this.frameSubs.delete(cb);
  }

  onEvent(cb: (e: BrowserEvent) => void) {
    this.eventSubs.add(cb);
    return () => this.eventSubs.delete(cb);
  }

  touch() {
    this.lastActiveAt = Date.now();
  }

  get isClosed() {
    return this.closed;
  }

  // ---- lifecycle ----

  private launchOptions() {
    const exe = process.env.SWARM_CHROME_PATH || process.env.CHROME_PATH;
    const args = [`--window-size=${this.limits.viewport.width},${this.limits.viewport.height}`];
    if (process.platform === "linux") args.push("--disable-dev-shm-usage");
    if (process.env.SWARM_BROWSER_NO_SANDBOX === "1") args.push("--no-sandbox");
    const h = headless();
    return {
      exe,
      base: {
        headless: h,
        acceptDownloads: true,
        args,
        env: browserEnv(),
        viewport: h ? this.limits.viewport : null,
      },
    };
  }

  /** Launch (or reuse) the isolated persistent context. Clears a stale profile lock left by a crash. */
  async context(): Promise<BrowserContext> {
    if (this.closed) throw new Error("This browser session was closed.");
    if (this.ctx) return this.ctx;
    if (this.launching) return this.launching;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    const { exe, base } = this.launchOptions();
    const attempt = () =>
      (exe
        ? chromium.launchPersistentContext(this.dir, { ...base, executablePath: exe })
        : chromium
            .launchPersistentContext(this.dir, { ...base, channel: "chrome" })
            .catch(() => chromium.launchPersistentContext(this.dir, { ...base, viewport: base.viewport ?? this.limits.viewport }))) as Promise<BrowserContext>;
    const self = this;
    this.launching = (async function launch() {
      try {
        return await attempt();
      } catch (first) {
        // A crashed browser leaves SingletonLock behind; Chrome then refuses to start. Clear and retry once.
        for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
          try {
            fs.rmSync(path.join(self.dir, f), { force: true });
          } catch {}
        try {
          return await attempt();
        } catch (second) {
          throw new Error(self.explainLaunchError(second ?? first));
        }
      }
    })();
    try {
      const c = await this.launching;
      this.ctx = c;
      c.on("close", () => this.hardClose("browser closed"));
      c.on("page", (p) => {
        this.watch(p);
        if (this.active && !this.active.isClosed()) this.log("A new tab opened; now controlling it. Use tab_switch to go back.");
        this.active = p;
        this.emitSpec({ type: "tab", ts: Date.now(), key: this.key, index: c.pages().indexOf(p) + 1, count: c.pages().length, url: p.url() });
      });
      c.pages().forEach((p) => this.watch(p));
      this.active = c.pages().find((p) => !p.isClosed()) ?? null;
      this.emitSpec({ type: "notice", ts: Date.now(), key: this.key, text: "Browser started (isolated profile).", level: "info" });
      void this.startScreencast();
      return c;
    } catch (e) {
      this.launching = null;
      this.ctx = null;
      throw e;
    }
  }

  private explainLaunchError(e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    if (/Executable doesn't exist|not found|ENOENT|install/i.test(msg))
      return "No Chrome/Chromium is installed for the browser tool. Install Google Chrome (desktop) or chromium (server) and set SWARM_CHROME_PATH if it isn't on the default path.";
    if (/display|X server|ozone/i.test(msg)) return "Chrome couldn't open a window (no display). Set SWARM_BROWSER_HEADLESS=1 to run it headless.";
    if (/SingletonLock|ProcessSingleton|profile appears to be in use/i.test(msg))
      return "The browser profile was locked by another process; the lock was cleared and the retry also failed. Try again.";
    return `Couldn't start the browser: ${msg.split("\n")[0]}`;
  }
}