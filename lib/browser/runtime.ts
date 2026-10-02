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

  // ---- pages & tabs ----

  /** The page the agent controls right now (recovering from a closed tab or a crash). */
  async page(): Promise<Page> {
    const c = await this.context();
    if (!this.active || this.active.isClosed()) this.active = c.pages().find((p) => !p.isClosed()) ?? (await this.newRawPage());
    return this.active;
  }

  private async newRawPage(): Promise<Page> {
    const p = await this.ctx!.newPage();
    this.watch(p);
    this.active = p;
    return p;
  }

  /** Open a tab, enforcing the per-session tab cap. */
  async newPage(url?: string): Promise<Page> {
    const c = await this.context();
    if (c.pages().filter((p) => !p.isClosed()).length >= this.limits.maxTabs)
      throw new Error(`Tab limit reached (${this.limits.maxTabs}). Close a tab before opening another.`);
    const p = await this.newRawPage();
    if (url) await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    this.touch();
    return p;
  }

  livePages() {
    return this.ctx?.pages().filter((p) => !p.isClosed()) ?? [];
  }

  tabs() {
    return this.livePages().map((p, i) => ({ index: i + 1, url: p.url(), active: p === this.active }));
  }

  async switchTab(n: number) {
    const pages = this.livePages();
    const p = pages[n - 1];
    if (!p) throw new Error(`No tab ${n} (there ${pages.length === 1 ? "is 1 tab" : `are ${pages.length} tabs`}).`);
    this.active = p;
    await p.bringToFront().catch(() => {});
    this.touch();
    return p;
  }

  async closeTab(n?: number) {
    const pages = this.livePages();
    const p = n ? pages[n - 1] : this.active;
    if (p) await p.close().catch(() => {});
    this.active = null;
    return this.page();
  }

  // ---- page instrumentation (downloads, dialogs, crashes) ----

  private watch(p: Page) {
    if (this.watched.has(p)) return;
    this.watched.add(p);
    p.on("download", (d) => {
      const job = (async () => {
        try {
          const name = d.suggestedFilename() || "download";
          if (!this.limits.downloadTypes.test(name)) {
            await d.cancel().catch(() => {});
            this.log(`Blocked download ${name}: file type not allowed.`);
            this.emitSpec({ type: "download", ts: Date.now(), key: this.key, name, bytes: 0, path: "", blocked: "type" });
            return;
          }
          const file = uniquePath(this.downloadsDir, name);
          await d.saveAs(file);
          const bytes = fs.statSync(file).size;
          if (bytes > this.limits.maxDownloadFileBytes || this.downloadedBytes + bytes > this.limits.maxDownloadBytes) {
            fs.rmSync(file, { force: true });
            this.log(`Blocked download ${name}: ${fmtSize(bytes)} exceeds the download limit.`);
            this.emitSpec({ type: "download", ts: Date.now(), key: this.key, name, bytes, path: "", blocked: "size" });
            return;
          }
          this.downloadedBytes += bytes;
          this.downloadList.push({ name: path.basename(file), bytes, path: file, at: Date.now() });
          this.log(`Downloaded ${path.basename(file)} (${fmtSize(bytes)}) to ${file}`);
          this.emitSpec({ type: "download", ts: Date.now(), key: this.key, name: path.basename(file), bytes, path: file });
        } catch (e) {
          this.log(`Download of ${d.suggestedFilename()} failed: ${(e as Error).message.split("\n")[0]}`);
        }
      })();
      this.pendingDownloads.add(job);
      job.finally(() => this.pendingDownloads.delete(job));
    });
    p.on("dialog", (d) => {
      this.log(`Page ${d.type()} dialog: "${d.message().slice(0, 300)}" (accepted)`);
      d.accept(d.type() === "prompt" ? d.defaultValue() : undefined).catch(() => {});
    });
    p.on("crash", () => {
      this.log("The page crashed; the runtime will reopen a tab.");
      this.emitSpec({ type: "notice", ts: Date.now(), key: this.key, text: "Page crashed — reopening.", level: "warn" });
      this.active = null;
    });
    p.on("framenavigated", () => {
      this.touch();
      void this.rememberState();
    });
  }

  /** Wait briefly for in-flight downloads so an observation can report them. */
  async settleDownloads(ms = 30_000) {
    if (!this.pendingDownloads.size) return;
    await Promise.race([Promise.allSettled([...this.pendingDownloads]), new Promise((r) => setTimeout(r, ms))]);
    if (this.pendingDownloads.size) this.log(`${this.pendingDownloads.size} download(s) still in progress; they'll be reported when done.`);
  }

  // ---- resume state ----

  private get stateFile() {
    return path.join(this.dir, "session-state.json");
  }

  /** Persist the open tabs so a restarted server can reopen the same pages. */
  async rememberState() {
    if (!this.ctx || this.closed) return;
    const urls = this.livePages()
      .map((p) => p.url())
      .filter((u) => u && u !== "about:blank");
    if (!urls.length) return;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ urls, at: Date.now() }));
    } catch {}
  }

  /** URLs the last run had open (empty when there is nothing to resume). */
  lastUrls(): string[] {
    try {
      const d = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as { urls?: string[] };
      return Array.isArray(d.urls) ? d.urls : [];
    } catch {
      return [];
    }
  }

  /** Reopen the pages this session had before a restart. */
  async resume() {
    const urls = this.lastUrls();
    if (!urls.length) return [];
    const opened: string[] = [];
    for (const u of urls.slice(0, this.limits.maxTabs)) {
      const p = await this.newPage(u);
      opened.push(p.url());
    }
    if (opened.length) {
      this.log(`Resumed browser session with ${opened.length} tab(s).`);
      this.emitSpec({ type: "notice", ts: Date.now(), key: this.key, text: `Resumed with ${opened.length} tab(s).`, level: "info" });
    }
    return opened;
  }

  // ---- CDP screencast ----

  cdpSession(): CDPSession | null {
    return this.cdp;
  }

  /** Start (or restart) the CDP screencast for the active page and fan frames out to viewers. */
  async startScreencast() {
    this.screencastOn = true;
    if (!this.ctx || this.closed) return;
    try {
      const p = await this.page();
      if (this.cdp) {
        try {
          await this.cdp.detach();
        } catch {}
        this.cdp = null;
      }
      const cdp = await this.ctx.newCDPSession(p);
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (f: { data: string; sessionId?: number; metadata?: { timestamp?: number; offsetTop?: number } }) => {
        const meta = f.metadata ?? {};
        const frame: ScreencastFrame = { data: f.data, ts: Number(meta.timestamp ?? 0) * 1000 || Date.now(), offsetTop: Number(meta.offsetTop ?? 0), n: ++this.frames };
        for (const cb of this.frameSubs) {
          try {
            cb(frame);
          } catch {}
        }
        cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId ?? 0 }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 860, everyNthFrame: 1 });
    } catch {
      // A closed page or detached session just means the next viewer reconnects.
    }
  }

  async stopScreencast() {
    try {
      await this.cdp?.send("Page.stopScreencast");
    } catch {}
  }

  // ---- control (who is driving) ----

  get isPaused() {
    return this.paused;
  }

  setController(who: "agent" | "user") {
    this.controller = who;
    this.paused = who === "user";
    this.emitSpec({ type: "control", ts: Date.now(), key: this.key, controller: who, paused: this.paused });
    if (who === "agent") this.releaseWaiters();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.emitSpec({ type: "control", ts: Date.now(), key: this.key, controller: this.controller, paused });
    if (!paused) this.releaseWaiters();
  }

  private releaseWaiters() {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** Resolve when the user has handed control back to the agent and the session isn't paused. */
  whenAgentTurn(): Promise<void> {
    if (this.controller === "agent" && !this.paused) return Promise.resolve();
    return new Promise((res) => this.waiters.add(res));
  }

  status(): BrowserStatus {
    const pages = this.livePages();
    return {
      key: this.key,
      live: !!this.ctx && !this.closed,
      controller: this.controller,
      paused: this.paused,
      url: this.active && !this.active.isClosed() ? this.active.url() : pages[0]?.url() ?? "",
      title: "",
      tabs: this.tabs().map((t) => ({ ...t, title: "" })),
      pointer: this.pointer,
      downloads: [...this.downloadList],
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
      frames: this.frames,
      note: this.note,
    };
  }

  // ---- shutdown ----

  /** Close the context and free the session. Viewers see a closed event. */
  async close(reason = "stopped") {
    if (this.closed) return;
    this.closed = true;
    this.note = reason;
    this.emitSpec({ type: "closed", ts: Date.now(), key: this.key, reason });
    this.releaseWaiters();
    this.frameSubs.clear();
    try {
      await this.stopScreencast();
    } catch {}
    try {
      await this.cdp?.detach();
    } catch {}
    this.cdp = null;
    try {
      await this.ctx?.close();
    } catch {}
    this.ctx = null;
    this.active = null;
  }

  /** Called by Chromium itself (crash/exit). Keeps the profile so resume can reopen it. */
  private hardClose(reason: string) {
    this.closed = true;
    this.note = reason;
    this.ctx = null;
    this.cdp = null;
    this.active = null;
    this.emitSpec({ type: "closed", ts: Date.now(), key: this.key, reason });
    this.releaseWaiters();
  }
}