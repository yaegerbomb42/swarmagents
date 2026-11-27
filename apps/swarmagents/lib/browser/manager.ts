/**
 * BrowserManager: server-side headless Chromium for the agent.
 *
 * Each run gets its own browser context (isolated cookies/storage). The
 * manager exposes the verbs the agent drives — `navigate`, `screenshot`,
 * `act` (click/type/press/scroll/wait), and read-only `evaluate` — and
 * publishes frame events onto the run's telemetry bus at most `MAX_FPS`
 * times per second. Frames themselves are not shipped inline over SSE: the
 * bus events carry only metadata (frameId, size, url, title), and the actual
 * JPEG bytes are served at `GET /api/runtime/browser/[runId]/frame`.
 * This keeps the event stream small (each frame is tens of KB) while still
 * publishing a change signal the UI can react to.
 *
 * Navigation policy (see ./policy.ts): only http/https, never file://, never
 * private / loopback / link-local address space. Hostnames that are not IP
 * literals are resolved *before* Chromium loads them (`dns.lookup`); if any
 * record lands in private space the navigation is refused. A Playwright route
 * handler applies the same DNS-aware check to every request the page makes —
 * subresources and each hop of a redirect chain — so a page cannot reach
 * private space sideways (e.g. by rebinding its hostname after the preflight).
 * After a successful load the final URL is re-checked against the same policy,
 * which catches redirect chains into file:// or private literals.
 *
 * The browser process is launched lazily on first use and shared across runs;
 * sessions idle for SESSION_IDLE_MS are closed by the sweeper, and a run's
 * session is closed automatically when the run reaches a terminal state.
 *
 * Backends (see ./cdp-endpoint.ts): on a real VM driver the manager mirrors
 * the Chromium the agent drives inside the user's VM, connecting over CDP
 * to the per-user endpoint (one browser connection per VM, shared across
 * that user's runs); the mirrored tab is never closed by this manager —
 * closing a session only detaches from it. On the fake driver the manager
 * keeps the historic host-launch behavior, but only behind
 * SWARM_BROWSER_HOST=1; otherwise there is no browser at all and every
 * control call fails with BROWSER_IN_VM_MESSAGE.
 */

import { promises as dns } from "node:dns";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { telemetryBus, type TelemetryBus } from "../telemetry/index";
import {
  evaluatePageExpression,
  executeBrowserAction,
  type BrowserAction,
  type BrowserDiagnosticEntry,
} from "./actions";
import {
  checkNavigation,
  checkNavigationAsync,
  isAddressLiteral,
  isLoopbackHostname,
  isPrivateHost,
  parseNavigationUrl,
} from "./policy";
import {
  BROWSER_IN_VM_MESSAGE,
  CDP_NO_TAB_MESSAGE,
  createDefaultCdpConnector,
  resolveBrowserMode,
  type BrowserMode,
  type CdpConnector,
} from "./cdp-endpoint";

/** One captured JPEG frame for a run. */
export interface BrowserFrame {
  frameId: number;
  jpeg: Buffer;
  width: number;
  height: number;
  capturedAt: number;
}

export type NavigateResult =
  | { ok: true; url: string; title: string }
  | { ok: false; reason: string };

export type ScreenshotResult =
  | { ok: true; frameId: number; width: number; height: number }
  | { ok: false; reason: string };

export type BrowserActResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export type BrowserEvaluateResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/** The control surface the routes (and tests) depend on. */
export interface BrowserControl {
  navigate(runId: string, url: string): Promise<NavigateResult>;
  screenshot(runId: string): Promise<ScreenshotResult>;
  act(runId: string, action: BrowserAction): Promise<BrowserActResult>;
  evaluate(runId: string, expression: string): Promise<BrowserEvaluateResult>;
  getDiagnostics(runId: string): Promise<BrowserDiagnosticEntry[]>;
  getFrame(runId: string): Promise<BrowserFrame | null>;
  close(runId: string): Promise<void>;
  /** Which backend serves this run's Browser tab (host / vm / unavailable). */
  getMode(): BrowserMode;
}

/** Cap on published frame rate (frames per second). */
export const MAX_FPS = 2;
const FRAME_MIN_INTERVAL_MS = Math.round(1000 / MAX_FPS);
/** Even without change signals, refresh at most this often (quiet pages idle). */
const FRAME_HEARTBEAT_MS = 2000;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 30_000;
const MAX_TITLE_LEN = 300;
/** Cap on concurrent browser sessions (Chromium contexts); bounds memory. */
export const MAX_SESSIONS = 16;
/** Ring-buffer cap on per-session diagnostic entries. */
const MAX_DIAGNOSTICS = 100;

interface RunSession {
  context: BrowserContext;
  page: Page;
  frame: BrowserFrame | null;
  frameSeq: number;
  url?: string;
  title?: string;
  pendingChange: boolean;
  lastUserActivityAt: number;
  lastCaptureAt: number;
  heartbeat: ReturnType<typeof setInterval>;
  unsubscribe: () => void;
  /** In-flight frame capture; concurrent callers coalesce onto one shot. */
  captureInFlight: Promise<BrowserFrame | null> | null;
  /** Console/pageerror/requestfailed entries, newest last, capped at 100. */
  diagnostics: BrowserDiagnosticEntry[];
  /**
   * True when this manager owns the context (host-launched Chromium): close()
   * may close it. False for a CDP-mirrored tab — the context belongs to the
   * VM's browser and must never be closed from here.
   */
  ownsContext: boolean;
  /** CDP endpoint this session mirrors (vm mode only). */
  endpoint?: string;
  /**
   * Generation bumped whenever the mirrored page switches (a new tab becomes
   * active) or the session closes; page listeners captured an older
   * generation ignore their events instead of acting on a stale page.
   */
  pageGeneration: number;
  /** True once close() ran; late page/context events are ignored. */
  closed: boolean;
}

/** Append one diagnostic entry, keeping only the newest MAX_DIAGNOSTICS. */
function pushDiagnostic(session: RunSession, entry: BrowserDiagnosticEntry): void {
  const diagnostics = (session.diagnostics ??= []);
  diagnostics.push(entry);
  if (diagnostics.length > MAX_DIAGNOSTICS) {
    diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
  }
}

function busPublish(bus: TelemetryBus, runId: string, type: string, data: unknown): void {
  try {
    bus.publish(runId, { type, data });
  } catch (err) {
    // Telemetry must never break a navigation.
    console.error(`[browser] could not publish ${type} for ${runId}:`, err);
  }
}

/** Resolve a hostname to all of its A/AAAA records (`[]` when unresolvable). */
async function lookupAddresses(host: string): Promise<string[]> {
  try {
    const records = await dns.lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * Preflight a non-literal hostname: if any DNS record resolves into address
 * space the policy forbids, refuse the navigation. Returns the blocked address
 * when found, else null.
 */
function dnsBlockedAddress(host: string, lookup: (host: string) => Promise<string[]>): Promise<string | null> {
  if (isAddressLiteral(host) || isLoopbackHostname(host)) return Promise.resolve(null);
  return lookup(host).then(
    (addresses) => addresses.find((addr) => isPrivateHost(addr)) ?? null,
    () => null,
  );
}

/**
 * Check one request URL (top-level navigation, subresource, or a hop in a
 * redirect chain) against the full policy, DNS resolution included. Returns
 * the offending host — the literal host, or a resolved address — when the
 * request must be refused, else null. Used by the Playwright route handler so
 * every request the page makes is vetted, not just the initial navigation.
 */
export async function requestBlockedByPolicy(
  raw: string,
  lookup: (host: string) => Promise<string[]>,
): Promise<string | null> {
  const url = parseNavigationUrl(raw);
  if (!url) return null;
  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const host = url.hostname;
  if (isPrivateHost(host)) return host;
  if (isLoopbackHostname(host)) return host;
  return dnsBlockedAddress(host, lookup);
}

function executablePath(): string | undefined {
  return process.env.PW_CHROMIUM_PATH?.trim() || process.env.SWARM_BROWSER_EXECUTABLE?.trim() || undefined;
}

export class BrowserManager implements BrowserControl {
  private readonly bus: TelemetryBus;
  /** DNS resolver used by the navigation preflight (injectable in tests). */
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly sessions = new Map<string, Promise<RunSession>>();
  /** One browser connection per backend endpoint (host launch or CDP URL). */
  private readonly browsersByEndpoint = new Map<string, Promise<Browser>>();
  /** Cap on concurrent sessions (bounds Chromium context/tab memory). */
  private readonly maxSessions: number;
  /** Chromium launcher (injectable in tests). */
  private readonly launch: (options: Parameters<typeof chromium.launch>[0]) => Promise<Browser>;
  /** True when the caller injected a launcher (host backend, e.g. in tests). */
  private readonly launchInjected: boolean;
  /** CDP connector (injectable in tests); lazily the production default. */
  private cdp: CdpConnector | null;
  /** Explicit backend override (tests); otherwise resolved from injections/env. */
  private readonly explicitMode: BrowserMode | undefined;
  /** Environment used for backend resolution (injectable in tests). */
  private readonly env: Readonly<Record<string, string | undefined>>;
  /** Live host-launched sessions; the host browser closes when this hits 0. */
  private hostSessionCount = 0;

  constructor(
    options: {
      bus?: TelemetryBus;
      lookup?: (host: string) => Promise<string[]>;
      maxSessions?: number;
      launch?: (options: Parameters<typeof chromium.launch>[0]) => Promise<Browser>;
      cdp?: CdpConnector;
      mode?: BrowserMode;
      env?: Readonly<Record<string, string | undefined>>;
    } = {},
  ) {
    this.bus = options.bus ?? telemetryBus;
    this.lookup = options.lookup ?? lookupAddresses;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.launch = options.launch ?? ((opts) => chromium.launch(opts));
    this.launchInjected = options.launch !== undefined;
    this.cdp = options.cdp ?? null;
    this.explicitMode = options.mode;
    this.env = options.env ?? process.env;
  }

  /**
   * Which backend this manager uses. An explicit mode wins; an injected CDP
   * connector means the VM mirror; an injected launcher means the historic
   * host browser (so existing tests that stub `launch` keep working); the
   * production default resolves from the environment (see cdp-endpoint).
   */
  getMode(): BrowserMode {
    if (this.explicitMode) return this.explicitMode;
    if (this.cdp) return "vm";
    if (this.launchInjected) return "host";
    return resolveBrowserMode(this.env);
  }

  private cdpConnector(): CdpConnector {
    if (!this.cdp) this.cdp = createDefaultCdpConnector();
    return this.cdp;
  }

  private browserStartError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    // The no-browser message is already user-facing; never wrap it.
    if (detail === BROWSER_IN_VM_MESSAGE) return detail;
    return this.getMode() === "vm"
      ? `Could not connect to the VM browser: ${detail}`
      : `Could not start headless Chromium: ${detail}`;
  }

  // --- lifecycle -----------------------------------------------------------

  /** Launch the shared host Chromium (the historic backend). */
  private launchHost(): Promise<Browser> {
    return this.launch({
      headless: true,
      executablePath: executablePath(),
      // The server runs in a container (often as root, no SUID sandbox);
      // Chromium cannot start otherwise. The sandbox adds little here: the
      // browser renders untrusted web content, but it is already isolated
      // inside this platform and never given host credentials.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }

  /**
   * One cached browser connection per backend endpoint. A failed open (or a
   * mid-run disconnect) must not poison later sessions: the entry is cleared
   * so the next call opens a fresh connection instead of reusing the dead one.
   */
  protected browserForEndpoint(key: string, open: () => Promise<Browser>): Promise<Browser> {
    let pending = this.browsersByEndpoint.get(key);
    if (!pending) {
      pending = open();
      pending.catch(() => {
        if (this.browsersByEndpoint.get(key) === pending) this.browsersByEndpoint.delete(key);
      });
      pending
        .then((browser) => {
          browser.on("disconnected", () => {
            if (this.browsersByEndpoint.get(key) === pending) this.browsersByEndpoint.delete(key);
          });
        })
        .catch(() => {});
      this.browsersByEndpoint.set(key, pending);
    }
    return pending;
  }

  protected browser(): Promise<Browser> {
    return this.browserForEndpoint("host", () => this.launchHost());
  }

  /** Resolve the CDP endpoint for a run, or throw a user-facing reason. */
  private async resolveCdpEndpoint(runId: string): Promise<string> {
    const endpoint = await this.cdpConnector().endpointForRun(runId);
    if (!endpoint) {
      throw new Error("Could not reach the VM browser (no CDP endpoint for this run).");
    }
    return endpoint;
  }

  /**
   * The mirrored page of a CDP browser: the default context's newest tab.
   * Polls briefly because the agent may be opening the browser right now;
   * null when no tab appears in time.
   */
  private async waitForMirrorPage(
    context: BrowserContext,
    timeoutMs = 2000,
  ): Promise<Page | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pages = context.pages();
      const latest = pages[pages.length - 1];
      if (latest) return latest;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * (Re)attach the mirror listeners to a page: navigation marks the run as
   * needing a fresh frame and captures one immediately, so the Browser tab
   * follows the agent's tab within about a second. `generation` is the
   * session's page generation at attach time; stale listeners no-op.
   */
  private attachMirrorListeners(runId: string, session: RunSession, page: Page): void {
    const generation = session.pageGeneration;
    const live = () => !session.closed && session.pageGeneration === generation && session.page === page;
    page.on("framenavigated", () => {
      if (!live()) return;
      session.pendingChange = true;
      session.lastUserActivityAt = Date.now();
      session.url = page.url();
      void page
        .title()
        .then((title) => {
          if (live()) session.title = title.slice(0, MAX_TITLE_LEN);
        })
        .catch(() => {});
      busPublish(this.bus, runId, "browser.navigated", { url: page.url(), title: session.title ?? "" });
      void this.captureFrame(runId, session, true);
    });
    page.on("load", () => {
      if (!live()) return;
      session.pendingChange = true;
      session.lastUserActivityAt = Date.now();
    });
    page.on("close", () => {
      if (!live()) return;
      // The mirrored tab closed; the next capture re-picks the newest tab.
      session.pendingChange = true;
    });
  }

  /**
   * Switch the mirror to a newly opened tab (the agent's latest tab is the
   * active one). Old-page listeners go stale via the generation bump.
   */
  private async switchMirrorPage(runId: string, session: RunSession, page: Page): Promise<void> {
    if (session.closed || session.page === page) return;
    session.pageGeneration += 1;
    session.page = page;
    session.url = page.url();
    session.title = (await page.title().catch(() => "")).slice(0, MAX_TITLE_LEN);
    session.pendingChange = true;
    session.lastUserActivityAt = Date.now();
    this.attachMirrorListeners(runId, session, page);
    await this.captureFrame(runId, session, true);
    busPublish(this.bus, runId, "browser.navigated", { url: session.url, title: session.title });
  }

  /** Re-pick the mirrored page when the current one closed (CDP sessions). */
  private async refreshMirrorPage(runId: string, session: RunSession): Promise<boolean> {
    if (session.ownsContext || session.closed) return true;
    if (!session.page.isClosed()) return true;
    const context = session.context;
    const page = await this.waitForMirrorPage(context);
    if (!page) return false;
    session.pageGeneration += 1;
    session.page = page;
    session.url = page.url();
    session.title = (await page.title().catch(() => "")).slice(0, MAX_TITLE_LEN);
    session.pendingChange = true;
    this.attachMirrorListeners(runId, session, page);
    return true;
  }

  /**
   * Make sure a CDP session's mirrored page is still alive before using it
   * (a closed tab re-picks the newest one). Host sessions always pass.
   */
  private async ensureLivePage(runId: string, session: RunSession): Promise<boolean> {
    return this.refreshMirrorPage(runId, session);
  }

  protected async createSession(runId: string): Promise<RunSession> {
    const mode = this.getMode();
    if (mode === "unavailable") throw new Error(BROWSER_IN_VM_MESSAGE);
    if (mode === "vm") return this.createCdpSession(runId);
    return this.createHostSession(runId);
  }

  /**
   * Attach to the Chromium the agent drives inside the user's VM. The
   * default context's newest tab is the mirrored page; a new tab opened by
   * the agent becomes the mirror. The context is NOT owned: closing the
   * session detaches, it never closes the agent's browser. No request
   * guards are attached here — the VM browser's traffic is already guarded
   * in-VM (the loopback policy proxy + the Playwright MCP init-page hook),
   * and a second route handler on the agent's page could break its browsing;
   * the navigation policy still applies to every user-initiated navigation
   * (see navigate()).
   */
  protected async createCdpSession(runId: string): Promise<RunSession> {
    const endpoint = await this.resolveCdpEndpoint(runId);
    const browser = await this.browserForEndpoint(endpoint, () =>
      this.cdpConnector().connect(endpoint),
    );
    const context = browser.contexts()[0];
    if (!context) throw new Error(CDP_NO_TAB_MESSAGE);
    const page = await this.waitForMirrorPage(context);
    if (!page) throw new Error(CDP_NO_TAB_MESSAGE);

    const session = {
      context,
      page,
      frame: null,
      frameSeq: 0,
      url: page.url(),
      title: (await page.title().catch(() => "")).slice(0, MAX_TITLE_LEN),
      pendingChange: true,
      lastUserActivityAt: Date.now(),
      lastCaptureAt: 0,
      captureInFlight: null as Promise<BrowserFrame | null> | null,
      diagnostics: [] as BrowserDiagnosticEntry[],
      ownsContext: false,
      endpoint,
      pageGeneration: 0,
      closed: false,
    } as RunSession;

    this.attachMirrorListeners(runId, session, page);
    this.attachDiagnostics(page, session);

    // A new tab opened by the agent becomes the mirrored page.
    context.on("page", (newPage: Page) => {
      void this.switchMirrorPage(runId, session, newPage);
    });

    // Auto-close when the run ends: detach from the mirror; the VM browser
    // itself keeps running for the agent.
    session.unsubscribe = this.bus.subscribe(runId, 0, (event) => {
      if (event.type === "run.finished" || event.type === "run.error" || event.type === "run.cancelled") {
        void this.close(runId);
      }
    });

    session.heartbeat = setInterval(() => {
      void this.captureFrame(runId, session, false);
    }, FRAME_HEARTBEAT_MS);
    session.heartbeat.unref?.();

    return session;
  }

  protected async createHostSession(runId: string): Promise<RunSession> {
    const browser = await this.browser();
    const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
    const page = await context.newPage();
    const session = {
      context,
      page,
      frame: null,
      frameSeq: 0,
      pendingChange: true,
      lastUserActivityAt: Date.now(),
      lastCaptureAt: 0,
      captureInFlight: null as Promise<BrowserFrame | null> | null,
      diagnostics: [] as BrowserDiagnosticEntry[],
      ownsContext: true,
      pageGeneration: 0,
      closed: false,
    } as RunSession;

    // Any browser activity marks the run as needing a fresh frame.
    page.on("load", () => {
      session.pendingChange = true;
      session.lastUserActivityAt = Date.now();
    });
    page.on("requestfinished", () => {
      session.pendingChange = true;
      session.lastUserActivityAt = Date.now();
    });

    this.attachDiagnostics(page, session);
    this.attachRequestGuards(page);

    // Auto-close when the run ends: no browser left running for a dead run.
    session.unsubscribe = this.bus.subscribe(runId, 0, (event) => {
      if (event.type === "run.finished" || event.type === "run.error" || event.type === "run.cancelled") {
        void this.close(runId);
      }
    });

    session.heartbeat = setInterval(() => {
      void this.captureFrame(runId, session, false);
    }, FRAME_HEARTBEAT_MS);
    session.heartbeat.unref?.();

    this.hostSessionCount += 1;
    return session;
  }

  /**
   * Console / page-error / failed-request diagnostics, kept as a capped
   * ring buffer on the session so the agent can see what went wrong on the
   * page without an unbounded log. Kept as a separate protected method so
   * tests can wire it onto a fake page exactly as a real session would.
   */
  protected attachDiagnostics(page: Page, session: RunSession): void {
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        pushDiagnostic(session, {
          ts: Date.now(),
          kind: "console",
          level: msg.type(),
          message: msg.text().slice(0, 1000),
        });
      }
    });
    page.on("pageerror", (err) => {
      pushDiagnostic(session, {
        ts: Date.now(),
        kind: "pageerror",
        level: "error",
        message: err.message.slice(0, 1000),
      });
    });
    page.on("requestfailed", (req) => {
      pushDiagnostic(session, {
        ts: Date.now(),
        kind: "requestfailed",
        level: "error",
        message: req.failure()?.errorText ?? "failed",
        url: req.url().slice(0, 512),
      });
    });
  }

  /**
   * Intercept every request the page makes and refuse ones that violate the
   * DNS-aware policy (see ./policy.ts). This closes the side channels a
   * navigation preflight cannot see: subresources, and redirect hops that
   * arrive after the initial resolution, including hostnames whose DNS answer
   * flipped since then (rebinding). Abort the request before Chromium sends
   * anything.
   */
  protected attachRequestGuards(page: Page): void {
    page.route("**/*", async (route, request) => {
      let blocked: string | null = null;
      try {
        blocked = await requestBlockedByPolicy(request.url(), this.lookup);
      } catch {
        // Fail closed: if the policy check itself errors we cannot prove the
        // destination is public, so refuse the request.
        blocked = "policy check failed";
      }
      if (blocked) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
  }

  private ensureSession(runId: string): Promise<RunSession> {
    let pending = this.sessions.get(runId);
    if (!pending) {
      if (this.sessions.size >= this.maxSessions) {
        return Promise.reject(
          new Error(`Browser session limit reached (${this.maxSessions} active sessions)`),
        );
      }
      pending = this.createSession(runId);
      this.sessions.set(runId, pending);
      // A failed launch must not poison the run forever; drop the entry so the
      // next call retries Chromium fresh.
      pending.catch(() => {
        if (this.sessions.get(runId) === pending) this.sessions.delete(runId);
      });
    }
    return pending;
  }

  /**
   * Close a run's browser session. Swallows errors (the browser may already be
   * closed) and always clears the session map entry. A CDP session only
   * detaches from the VM browser — the context and browser belong to the
   * agent's VM and are never closed from here. The shared host browser is
   * closed only when the last host session goes away.
   */
  async close(runId: string): Promise<void> {
    const pending = this.sessions.get(runId);
    if (!pending) return;
    this.sessions.delete(runId);
    try {
      const session = await pending;
      clearInterval(session.heartbeat);
      session.unsubscribe();
      session.closed = true;
      session.pageGeneration += 1;
      if (session.ownsContext) {
        this.hostSessionCount = Math.max(0, this.hostSessionCount - 1);
        await session.context.close().catch(() => {});
      }
    } catch {
      // Session creation itself failed; nothing to tear down.
    }
    if (this.hostSessionCount === 0) {
      const hostBrowser = this.browsersByEndpoint.get("host");
      if (hostBrowser) {
        this.browsersByEndpoint.delete("host");
        await hostBrowser.then((browser) => browser.close()).catch(() => {});
      }
    }
  }

  /** Close sessions idle too long (periodic sweeper). */
  async prune(now: number = Date.now()): Promise<number> {
    let closed = 0;
    for (const runId of [...this.sessions.keys()]) {
      const pending = this.sessions.get(runId);
      if (!pending) continue;
      try {
        const session = await pending;
        if (now - session.lastUserActivityAt > SESSION_IDLE_MS) {
          await this.close(runId);
          closed += 1;
        }
      } catch {
        // Stale failed session; the ensureSession catch already dropped it.
      }
    }
    return closed;
  }

  // --- control plane -------------------------------------------------------

  /**
   * Navigate the run's browser to `url`. Policy violations (bad scheme,
   * private address, unresolvable or private-resolving hostname) are refused
   * before Chromium loads anything, and the destination is double-checked
   * after load (redirect handling).
   */
  async navigate(runId: string, raw: string): Promise<NavigateResult> {
    const fail = (reason: string): NavigateResult => {
      busPublish(this.bus, runId, "browser.error", { action: "navigate", url: raw, reason });
      return { ok: false, reason };
    };

    // Shared DNS-aware check: syntactic policy first, then the A/AAAA preflight
    // using the (injectable) resolver.
    const check = await checkNavigationAsync(raw, this.lookup);
    if (!check.ok) return fail(check.reason);

    let session: RunSession;
    try {
      session = await this.ensureSession(runId);
    } catch (error) {
      return fail(this.browserStartError(error));
    }
    if (!(await this.ensureLivePage(runId, session))) {
      return fail(CDP_NO_TAB_MESSAGE);
    }

    try {
      await session.page.goto(check.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch (error) {
      return fail(`Failed to load ${check.url}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Re-check the final URL: a public page may redirect into file:// or a
    // private literal, and we will not hand that page to the agent.
    const finalUrl = session.page.url();
    const finalCheck = checkNavigation(finalUrl);
    if (!finalCheck.ok) {
      await session.page.goto("about:blank").catch(() => {});
      return fail(`Refusing redirected destination: ${finalCheck.reason}`);
    }
    const finalBlocked = await dnsBlockedAddress(new URL(finalUrl).hostname, this.lookup);
    if (finalBlocked) {
      await session.page.goto("about:blank").catch(() => {});
      return fail(`Refusing redirected destination: resolves to private address ${finalBlocked}`);
    }

    const title = (await session.page.title().catch(() => "")).slice(0, MAX_TITLE_LEN);
    session.url = finalUrl;
    session.title = title;
    session.pendingChange = true;
    session.lastUserActivityAt = Date.now();
    busPublish(this.bus, runId, "browser.navigated", { url: finalUrl, title });
    await this.captureFrame(runId, session, true);
    return { ok: true, url: finalUrl, title };
  }

  /** Capture the current page immediately (the agent's "take a screenshot"). */
  async screenshot(runId: string): Promise<ScreenshotResult> {
    let session: RunSession;
    try {
      session = await this.ensureSession(runId);
    } catch (error) {
      const reason = this.browserStartError(error);
      busPublish(this.bus, runId, "browser.error", { action: "screenshot", reason });
      return { ok: false, reason };
    }
    if (!(await this.ensureLivePage(runId, session))) {
      const reason = CDP_NO_TAB_MESSAGE;
      busPublish(this.bus, runId, "browser.error", { action: "screenshot", reason });
      return { ok: false, reason };
    }
    const frame = await this.captureFrame(runId, session, true);
    if (!frame) {
      const reason = "No browser page to screenshot (navigate first)";
      busPublish(this.bus, runId, "browser.error", { action: "screenshot", reason });
      return { ok: false, reason };
    }
    return { ok: true, frameId: frame.frameId, width: frame.width, height: frame.height };
  }

  /**
   * Run an interactive action (click/type/press/scroll/wait) on the run's
   * page. The current URL is re-verified against the DNS-aware policy before
   * and after the action, so a click or script that redirects the page into
   * private space is caught (the page is blanked) instead of handed to the
   * agent. A post-action frame is captured and a `browser.acted` event is
   * published.
   */
  async act(runId: string, action: BrowserAction): Promise<BrowserActResult> {
    const fail = (reason: string): BrowserActResult => {
      busPublish(this.bus, runId, "browser.error", { action: action.kind, reason });
      return { ok: false, reason };
    };

    let session: RunSession;
    try {
      session = await this.ensureSession(runId);
    } catch (error) {
      return fail(this.browserStartError(error));
    }

    if (!(await this.ensureLivePage(runId, session))) {
      return fail(CDP_NO_TAB_MESSAGE);
    }

    const before = await this.verifyCurrentUrl(session);
    if (!before.ok) return fail(before.reason);

    try {
      await executeBrowserAction(session.page, action);
    } catch (error) {
      return fail(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    session.pendingChange = true;
    session.lastUserActivityAt = Date.now();

    const after = await this.verifyCurrentUrl(session);
    if (!after.ok) return fail(after.reason);

    await this.captureFrame(runId, session, true);
    busPublish(this.bus, runId, "browser.acted", { action: action.kind, url: session.page.url() });
    return { ok: true, url: session.page.url() };
  }

  /**
   * Evaluate a bounded, read-only JS expression in the page and return its
   * JSON-serializable result. The current URL is re-verified before and
   * after, exactly as for `act`, because a script can navigate the page.
   */
  async evaluate(runId: string, expression: string): Promise<BrowserEvaluateResult> {
    const fail = (reason: string): BrowserEvaluateResult => {
      busPublish(this.bus, runId, "browser.error", { action: "evaluate", reason });
      return { ok: false, reason };
    };

    let session: RunSession;
    try {
      session = await this.ensureSession(runId);
    } catch (error) {
      return fail(this.browserStartError(error));
    }

    if (!(await this.ensureLivePage(runId, session))) {
      return fail(CDP_NO_TAB_MESSAGE);
    }

    const before = await this.verifyCurrentUrl(session);
    if (!before.ok) return fail(before.reason);

    let value: unknown;
    try {
      value = await evaluatePageExpression(session.page, expression);
    } catch (error) {
      return fail(`Evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    session.lastUserActivityAt = Date.now();

    const after = await this.verifyCurrentUrl(session);
    if (!after.ok) return fail(after.reason);

    await this.captureFrame(runId, session, true);
    return { ok: true, value };
  }

  /** Diagnostic entries captured for a run (newest last, capped at 100). */
  async getDiagnostics(runId: string): Promise<BrowserDiagnosticEntry[]> {
    const pending = this.sessions.get(runId);
    if (!pending) return [];
    try {
      const session = await pending;
      return [...(session.diagnostics ?? [])];
    } catch {
      return [];
    }
  }

  /**
   * Re-verify the page's current URL against the DNS-aware policy. A page
   * that has not navigated yet (`about:blank`) has nothing to guard and
   * passes. A page that moved somewhere blocked is blanked and refused.
   */
  private async verifyCurrentUrl(session: RunSession): Promise<{ ok: true } | { ok: false; reason: string }> {
    const url = session.page.url();
    if (url === "about:blank") return { ok: true };
    const check = await checkNavigationAsync(url, this.lookup);
    if (!check.ok) {
      await session.page.goto("about:blank").catch(() => {});
      return { ok: false, reason: `Refusing current destination: ${check.reason}` };
    }
    return { ok: true };
  }

  /** Latest frame for a run (null until the first capture). */
  async getFrame(runId: string): Promise<BrowserFrame | null> {
    const pending = this.sessions.get(runId);
    if (!pending) return null;
    try {
      const session = await pending;
      return session.frame;
    } catch {
      return null;
    }
  }

  // --- frame capture -------------------------------------------------------

  /**
   * Capture a JPEG frame of the run's page and publish a `browser.frame`
   * event. Rate-limited to MAX_FPS: forced captures (navigation, explicit
   * screenshot) bypass the throttle but never exceed the fps cap, and
   * heartbeat captures only fire when the page has actually changed since the
   * last shot (or the heartbeat window elapsed).
   */
  /**
   * Capture a JPEG frame, coalescing concurrent callers onto one in-flight
   * shot so overlapping forced and heartbeat captures never run
   * `page.screenshot` twice or record an out-of-order `frameSeq`.
   */
  private async captureFrame(runId: string, session: RunSession, force: boolean): Promise<BrowserFrame | null> {
    if (session.captureInFlight) return session.captureInFlight;
    const flight = this.doCaptureFrame(runId, session, force);
    session.captureInFlight = flight;
    try {
      return await flight;
    } finally {
      if (session.captureInFlight === flight) session.captureInFlight = null;
    }
  }

  private async doCaptureFrame(runId: string, session: RunSession, force: boolean): Promise<BrowserFrame | null> {
    const now = Date.now();
    if (!force && !session.pendingChange && now - session.lastCaptureAt < FRAME_HEARTBEAT_MS) {
      return session.frame;
    }
    if (!force && now - session.lastCaptureAt < FRAME_MIN_INTERVAL_MS) {
      return session.frame;
    }
    try {
      const jpeg = await session.page.screenshot({ type: "jpeg", quality: 70 });
      const viewport = session.page.viewportSize() ?? DEFAULT_VIEWPORT;
      session.frame = {
        frameId: ++session.frameSeq,
        jpeg,
        width: viewport.width,
        height: viewport.height,
        capturedAt: now,
      };
      session.pendingChange = false;
      session.lastCaptureAt = now;
      // Only explicit/forced captures (navigation, screenshot, actions,
      // evaluate) count as user activity. Heartbeat captures refresh the
      // frame but must not keep an idle session alive.
      if (force) session.lastUserActivityAt = now;
      busPublish(this.bus, runId, "browser.frame", {
        frameId: session.frame.frameId,
        width: session.frame.width,
        height: session.frame.height,
        url: session.url,
        title: session.title,
      });
    } catch (error) {
      // The page crashed or closed mid-capture; keep the previous frame.
      console.error(`[browser] frame capture failed for ${runId}:`, error instanceof Error ? error.message : error);
    }
    return session.frame;
  }
}

/**
 * Process-wide singleton (same pattern as the telemetry bus / runtime
 * manager) so route handlers share one Chromium process.
 */
const g = globalThis as typeof globalThis & { __swarmBrowserManager?: BrowserManager };
export function getBrowserManager(): BrowserManager {
  if (!g.__swarmBrowserManager) {
    g.__swarmBrowserManager = new BrowserManager();
    const sweeper = setInterval(() => void g.__swarmBrowserManager?.prune(), 60_000);
    sweeper.unref?.();
  }
  return g.__swarmBrowserManager;
}

/** Test hook: swap the singleton for a stub manager. */
export function setBrowserManagerForTesting(manager: BrowserControl | null): void {
  g.__swarmBrowserManager = (manager ?? undefined) as BrowserManager | undefined;
}
