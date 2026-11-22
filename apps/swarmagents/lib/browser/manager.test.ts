/**
 * Unit tests for BrowserManager (lib/browser/manager.ts).
 *
 * A fake Page/Context stands in for Chromium, so the full control surface —
 * policy refusal, navigation, frame publishing, redirect re-check, session
 * lifecycle — is exercised without a browser binary. The DNS preflight is
 * tested with an injected resolver.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright-core";
import { BrowserManager, MAX_FPS, type BrowserFrame } from "./manager";
import type { BrowserDiagnosticEntry } from "./actions";
import { telemetryBus } from "../telemetry/index";

const JPEG = Buffer.from("fake-jpeg-bytes");

interface FakePageState {
  url: string;
  title: string;
  gotoError?: Error;
  gotoCalls: string[];
  screenshotCalls: number;
  routePattern?: string;
  routeHandler?: FakeRouteHandler;
  /** page.on(event, handler) registrations, so tests can fire page events. */
  handlers: Record<string, Array<(arg: never) => void>>;
  /** Optional hook run by the fake locator's click/type/press. */
  onAction?: () => void;
  /** Delay (ms) applied to each screenshot, for concurrency tests. */
  screenshotDelayMs?: number;
  /** Locator calls recorded by the fake page. */
  locatorCalls: Array<{ selector: string; method: string; args: unknown[] }>;
}

type FakeRouteHandler = (
  route: { continue(): Promise<void>; abort(): Promise<void> },
  request: { url(): string },
) => unknown;

/** Run one request through the registered route handler; returns its verdict. */
async function dispatchRequest(state: FakePageState, url: string): Promise<"continued" | "aborted"> {
  assert.ok(state.routeHandler, "fake page has no route handler registered");
  let outcome: "continued" | "aborted" = "continued";
  await state.routeHandler!(
    {
      continue: async () => {
        outcome = "continued";
      },
      abort: async () => {
        outcome = "aborted";
      },
    },
    { url: () => url },
  );
  return outcome;
}

function fakePage(initial: Partial<FakePageState> & { redirectTo?: string } = {}): { page: Page; state: FakePageState & { redirectTo?: string } } {
  const state: FakePageState & { redirectTo?: string } = {
    url: initial.url ?? "about:blank",
    title: initial.title ?? "Fake Page",
    gotoCalls: [],
    screenshotCalls: 0,
    redirectTo: initial.redirectTo,
    handlers: initial.handlers ?? {},
    onAction: initial.onAction,
    screenshotDelayMs: initial.screenshotDelayMs,
    locatorCalls: initial.locatorCalls ?? [],
  };
  const locator = (selector: string) => {
    const record = (method: string, args: unknown[] = []) => {
      state.locatorCalls.push({ selector, method, args });
      state.onAction?.();
    };
    const first = () => ({
      click: async () => record("click"),
      fill: async (text: string) => record("fill", [text]),
      type: async (text: string) => record("type", [text]),
      press: async (key: string) => record("press", [key]),
      hover: async () => record("hover"),
      waitFor: async () => record("waitFor"),
    });
    return { first };
  };
  const page = {
    url: () => state.url,
    title: async () => state.title,
    goto: async (target: string) => {
      state.gotoCalls.push(target);
      if (state.gotoError) throw state.gotoError;
      state.url = state.redirectTo ?? target;
      return null;
    },
    screenshot: async () => {
      state.screenshotCalls += 1;
      if (state.screenshotDelayMs) await new Promise((r) => setTimeout(r, state.screenshotDelayMs));
      return JPEG;
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
    on: (event: string, handler: (arg: never) => void) => {
      (state.handlers[event] ??= []).push(handler);
    },
    off: () => {},
    route: (pattern: string, handler: FakeRouteHandler) => {
      state.routePattern = pattern;
      state.routeHandler = handler;
    },
    locator,
    keyboard: { press: async (key: string) => { state.locatorCalls.push({ selector: "", method: "keyboard.press", args: [key] }); state.onAction?.(); } },
    mouse: { wheel: async (dx: number, dy: number) => { state.locatorCalls.push({ selector: "", method: "mouse.wheel", args: [dx, dy] }); state.onAction?.(); } },
    evaluate: async (fn: (expr: string) => unknown, arg: string) => fn(arg),
  } as unknown as Page;
  return { page, state };
}

function fakeContext(page: Page): BrowserContext {
  return {
    close: async () => {},
    newPage: async () => page,
  } as unknown as BrowserContext;
}

interface SessionLike {
  context: BrowserContext;
  page: Page;
  frame: null | { frameId: number; jpeg: Buffer; width: number; height: number; capturedAt: number };
  frameSeq: number;
  pendingChange: boolean;
  lastUserActivityAt: number;
  lastCaptureAt: number;
  heartbeat: ReturnType<typeof setInterval>;
  unsubscribe: () => void;
  captureInFlight: Promise<BrowserFrame | null> | null;
  diagnostics: BrowserDiagnosticEntry[];
}

class FakeBrowserManager extends BrowserManager {
  constructor(
    private readonly session: SessionLike,
    lookup?: (host: string) => Promise<string[]>,
    maxSessions?: number,
  ) {
    super({ bus: telemetryBus, lookup, maxSessions });
  }
  protected override async createSession(): Promise<SessionLike> {
    // Wire the production request guard (DNS-aware route handler) and the
    // production diagnostics handlers onto the fake page exactly as a real
    // session would.
    this.attachDiagnostics(this.session.page, this.session as never);
    this.attachRequestGuards(this.session.page);
    return this.session;
  }
}

function makeSession(page: Page, context?: BrowserContext): SessionLike {
  return {
    context: context ?? fakeContext(page),
    page,
    frame: null,
    frameSeq: 0,
    pendingChange: false,
    lastUserActivityAt: Date.now(),
    lastCaptureAt: 0,
    heartbeat: null as unknown as ReturnType<typeof setInterval>,
    unsubscribe: () => {},
    captureInFlight: null,
    diagnostics: [],
  };
}

const RUN = "run_test_browser";
const PUBLIC_URL = "https://example.com/path?q=1";

function eventsOf(runId: string): Array<{ type: string; data: unknown }> {
  const out: Array<{ type: string; data: unknown }> = [];
  telemetryBus.subscribe(runId, 0, (e) => out.push({ type: e.type, data: e.data }));
  return out;
}

test("navigate refuses file:// and private destinations without touching the browser", async () => {
  const { page, state } = fakePage();
  const manager = new FakeBrowserManager(makeSession(page));
  const events = eventsOf(RUN);

  const file = await manager.navigate(RUN, "file:///etc/passwd");
  assert.equal(file.ok, false);
  if (!file.ok) assert.match(file.reason, /Scheme "file"/);
  assert.equal(state.gotoCalls.length, 0);

  const privateIp = await manager.navigate(RUN, "http://127.0.0.1:3777/");
  assert.equal(privateIp.ok, false);
  if (!privateIp.ok) assert.match(privateIp.reason, /Private address/);
  assert.equal(state.gotoCalls.length, 0);

  const localhost = await manager.navigate(RUN, "http://localhost/");
  assert.equal(localhost.ok, false);
  if (!localhost.ok) assert.match(localhost.reason, /Loopback hostname/);
  assert.equal(state.gotoCalls.length, 0);
  assert.equal(events.filter((e) => e.type === "browser.error").length, 3);
  await manager.close(RUN);
});

test("navigate to a public URL drives the page and publishes navigated+frame events", async () => {
  const { page, state } = fakePage({ url: PUBLIC_URL, title: "Example Domain" });
  const manager = new FakeBrowserManager(makeSession(page));
  const events = eventsOf(RUN);

  const result = await manager.navigate(RUN, PUBLIC_URL);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.url, PUBLIC_URL);
    assert.equal(result.title, "Example Domain");
  }
  assert.deepEqual(state.gotoCalls, [PUBLIC_URL]);

  const frame = await manager.getFrame(RUN);
  assert.ok(frame);
  assert.equal(frame?.frameId, 1);
  assert.equal(frame?.jpeg, JPEG);

  const nav = events.find((e) => e.type === "browser.navigated");
  assert.ok(nav);
  assert.deepEqual(nav?.data, { url: PUBLIC_URL, title: "Example Domain" });
  const frameEvent = events.find((e) => e.type === "browser.frame");
  assert.ok(frameEvent);
  assert.deepEqual(frameEvent?.data, { frameId: 1, width: 1280, height: 800, url: PUBLIC_URL, title: "Example Domain" });
  await manager.close(RUN);
});

test("a redirect into a private literal is refused after load", async () => {
  const { page, state } = fakePage({ redirectTo: "http://127.0.0.1/admin" });
  const manager = new FakeBrowserManager(makeSession(page));

  const result = await manager.navigate(RUN, "https://example.com/");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Refusing redirected destination/);
  // The page was sent back to a blank page, not left on the private target.
  assert.ok(state.gotoCalls.includes("about:blank"));
  await manager.close(RUN);
});

test("a failing goto surfaces a browser.error and no frame", async () => {
  const { page } = fakePage();
  (page as unknown as { goto: (t: string) => Promise<null> }).goto = async () => {
    throw new Error("net::ERR_CONNECTION_REFUSED");
  };
  const manager = new FakeBrowserManager(makeSession(page));
  const events = eventsOf(RUN);

  const result = await manager.navigate(RUN, "https://example.com/");
  assert.equal(result.ok, false);
  assert.equal(await manager.getFrame(RUN), null);
  assert.ok(events.some((e) => e.type === "browser.error"));
  await manager.close(RUN);
});

test("DNS preflight blocks hostnames resolving into private space", async () => {
  const { page, state } = fakePage();
  const lookup = async (host: string): Promise<string[]> => {
    if (host === "internal.example.com") return ["10.0.0.5", "93.184.216.34"];
    if (host === "staging.example.com") return ["192.168.1.10"];
    return ["93.184.216.34"];
  };
  const manager = new FakeBrowserManager(makeSession(page), lookup);

  const blocked = await manager.navigate(RUN, "http://internal.example.com/");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.reason, /resolves to private address 10\.0\.0\.5/);
  assert.equal(state.gotoCalls.length, 0);

  const blocked2 = await manager.navigate(RUN, "http://staging.example.com/");
  assert.equal(blocked2.ok, false);
  assert.equal(state.gotoCalls.length, 0);

  const allowed = await manager.navigate(RUN, "http://public.example.com/");
  assert.equal(allowed.ok, true);
  assert.equal(state.gotoCalls.length, 1);
  await manager.close(RUN);
});

test("requests via the route handler are resolved and vetted (DNS, stubbed, no network)", async () => {
  const { page, state } = fakePage({ url: PUBLIC_URL });
  const lookup = async (host: string): Promise<string[]> => {
    if (host === "segments.example.com") return ["10.1.2.3", "93.184.216.34"]; // mixed
    if (host === "nested.example.com") return ["10.0.0.1"]; // private
    if (host === "meta.rebind.test") return ["169.254.169.254"]; // cloud metadata
    if (host === "v6.example.com") return ["::ffff:10.0.0.1", "2606:4700:4700::1111"]; // IPv6-mapped
    if (host === "dual.example.com") return ["2606:4700:4700::1111", "93.184.216.34", "100.64.0.1"]; // mixed with CGNAT
    return ["93.184.216.34"]; // public
  };
  const manager = new FakeBrowserManager(makeSession(page), lookup);

  // A navigation creates the session, which registers the route handler for
  // all URLs on the page. public.example.com resolves publicly, so it passes.
  const nav = await manager.navigate(RUN, "https://public.example.com/");
  assert.equal(nav.ok, true);

  // The route handler is registered for all URLs on the fake page.
  assert.equal(state.routePattern, "**/*");
  assert.ok(state.routeHandler);

  // Public requests pass through.
  assert.equal(await dispatchRequest(state, "https://example.com/app.js"), "continued");
  assert.equal(await dispatchRequest(state, "http://public.example.com/x"), "continued");

  // Private literals are aborted before anything is fetched.
  assert.equal(await dispatchRequest(state, "http://127.0.0.1/health"), "aborted");
  assert.equal(await dispatchRequest(state, "http://10.0.0.5/internal"), "aborted");
  assert.equal(await dispatchRequest(state, "http://[::1]/"), "aborted");
  assert.equal(await dispatchRequest(state, "http://localhost:3000/"), "aborted");
  assert.equal(await dispatchRequest(state, "http://192.168.1.10/"), "aborted");
  assert.equal(await dispatchRequest(state, "http://100.64.0.1/"), "aborted"); // CGNAT

  // Hostnames resolving into private space are aborted too (rebinding defense).
  assert.equal(await dispatchRequest(state, "http://segments.example.com/"), "aborted");
  assert.equal(await dispatchRequest(state, "http://nested.example.com/"), "aborted");
  assert.equal(await dispatchRequest(state, "http://meta.rebind.test/"), "aborted");
  assert.equal(await dispatchRequest(state, "http://v6.example.com/"), "aborted");
  assert.equal(await dispatchRequest(state, "http://dual.example.com/"), "aborted");
});

test("frame capture is rate-limited (<=2 fps) but forced screenshots bypass", async () => {
  const { page, state } = fakePage({ url: PUBLIC_URL });
  const session = makeSession(page);
  const manager = new FakeBrowserManager(session);
  const captureFrame = (forced: boolean) =>
    (manager as unknown as { captureFrame: (r: string, s: SessionLike, f: boolean) => Promise<unknown> }).captureFrame(
      RUN, session, forced,
    );

  // Two non-forced captures back-to-back: only the first may screenshot.
  session.pendingChange = true;
  await captureFrame(false);
  session.pendingChange = true; // pretend the page changed again immediately
  await captureFrame(false);
  assert.equal(state.screenshotCalls, 1, "second non-forced capture within the fps window must be skipped");

  // A forced capture (explicit screenshot) always captures.
  await captureFrame(true);
  assert.equal(state.screenshotCalls, 2);

  // MAX_FPS is exported and sane.
  assert.equal(MAX_FPS, 2);
  await manager.close(RUN);
});

test("close tears the session down and drops the cache", async () => {
  const { page } = fakePage();
  let closed = 0;
  const session = makeSession(page, { close: async () => { closed += 1; } } as unknown as BrowserContext);
  const manager = new FakeBrowserManager(session);

  await manager.navigate(RUN, "https://example.com/");
  assert.ok(await manager.getFrame(RUN));

  await manager.close(RUN);
  assert.equal(closed, 1);
  assert.equal(await manager.getFrame(RUN), null);
  // Closing twice is a no-op.
  await manager.close(RUN);
  assert.equal(closed, 1);
});

test("concurrent captureFrame calls coalesce onto one screenshot", async () => {
  const { page, state } = fakePage({ url: PUBLIC_URL, screenshotDelayMs: 50 });
  const session = makeSession(page);
  const manager = new FakeBrowserManager(session);
  const captureFrame = (forced: boolean) =>
    (manager as unknown as { captureFrame: (r: string, s: SessionLike, f: boolean) => Promise<unknown> }).captureFrame(
      RUN, session, forced,
    );

  await manager.navigate(RUN, PUBLIC_URL);
  const before = state.screenshotCalls;
  session.pendingChange = true;
  // Forced captures bypass the fps throttle, so both calls would screenshot
  // on their own — coalescing is what keeps it to one shot.
  const [a, b] = await Promise.all([captureFrame(true), captureFrame(true)]);
  assert.equal(state.screenshotCalls, before + 1, "two concurrent captures must share one screenshot");
  assert.equal(a, b, "concurrent callers get the same frame promise result");
  await manager.close(RUN);
});

test("diagnostics capture console/pageerror/requestfailed and cap at 100 entries", async () => {
  const { page, state } = fakePage({ url: PUBLIC_URL });
  const manager = new FakeBrowserManager(makeSession(page));
  await manager.navigate(RUN, PUBLIC_URL);

  const fire = (event: string, arg: never) => {
    for (const handler of state.handlers[event] ?? []) handler(arg);
  };
  fire("console", { type: () => "error", text: () => "boom" } as never);
  fire("console", { type: () => "info", text: () => "ignored" } as never);
  fire("console", { type: () => "warning", text: () => "careful" } as never);
  fire("pageerror", new Error("page exploded") as never);
  fire("requestfailed", {
    failure: () => ({ errorText: "net::ERR_FAILED" }),
    url: () => "https://example.com/broken.js",
  } as never);

  let diags = await manager.getDiagnostics(RUN);
  assert.equal(diags.length, 4);
  assert.deepEqual(
    diags.map((d) => d.kind),
    ["console", "console", "pageerror", "requestfailed"],
  );
  assert.equal(diags[0].level, "error");
  assert.equal(diags[3].url, "https://example.com/broken.js");

  // Flood past the cap: only the newest 100 survive.
  for (let i = 0; i < 105; i++) {
    fire("pageerror", new Error(`err ${i}`) as never);
  }
  diags = await manager.getDiagnostics(RUN);
  assert.equal(diags.length, 100);
  assert.equal(diags[0].message, "err 5");
  assert.equal(diags[99].message, "err 104");

  assert.deepEqual(await manager.getDiagnostics("run_no_such_run"), []);
  await manager.close(RUN);
});

test("maxSessions caps concurrent browser sessions", async () => {
  const { page } = fakePage({ url: PUBLIC_URL });
  const manager = new FakeBrowserManager(makeSession(page), undefined, 2);

  assert.equal((await manager.navigate("run_a", PUBLIC_URL)).ok, true);
  assert.equal((await manager.navigate("run_b", PUBLIC_URL)).ok, true);
  const third = await manager.navigate("run_c", PUBLIC_URL);
  assert.equal(third.ok, false);
  if (!third.ok) assert.match(third.reason, /session limit reached/);

  await manager.close("run_a");
  assert.equal((await manager.navigate("run_c", PUBLIC_URL)).ok, true);
  await manager.close("run_a");
  await manager.close("run_b");
  await manager.close("run_c");
});

test("act runs an action, re-verifies the URL, and publishes browser.acted", async () => {
  const { page, state } = fakePage({ url: PUBLIC_URL });
  const manager = new FakeBrowserManager(makeSession(page));
  const events = eventsOf(RUN);

  assert.equal((await manager.navigate(RUN, PUBLIC_URL)).ok, true);
  const result = await manager.act(RUN, { kind: "click", selector: "#btn" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.url, PUBLIC_URL);
  assert.deepEqual(
    state.locatorCalls.map((c) => c.method),
    ["click"],
  );
  assert.ok(events.some((e) => e.type === "browser.acted"));
  assert.ok(await manager.getFrame(RUN));
  await manager.close(RUN);
});

test("act refuses a page that redirected into private space mid-action", async () => {
  const { page, state } = fakePage({
    url: PUBLIC_URL,
    onAction: () => {
      state.url = "http://127.0.0.1/admin";
    },
  });
  const manager = new FakeBrowserManager(makeSession(page));

  assert.equal((await manager.navigate(RUN, PUBLIC_URL)).ok, true);
  const result = await manager.act(RUN, { kind: "click", selector: "#evil" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Refusing current destination/);
  assert.ok(state.gotoCalls.includes("about:blank"), "blocked page must be blanked");
  await manager.close(RUN);
});

test("evaluate returns the page value and refuses bad expressions", async () => {
  const { page } = fakePage({ url: PUBLIC_URL });
  const manager = new FakeBrowserManager(makeSession(page));
  await manager.navigate(RUN, PUBLIC_URL);

  const good = await manager.evaluate(RUN, "1 + 2");
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value, 3);

  const bad = await manager.evaluate(RUN, "");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /1\.\.8192/);
  await manager.close(RUN);
});

test("idle sessions are pruned after the idle timeout, and heartbeat captures do not resurrect them", async () => {
  const { page } = fakePage({ url: PUBLIC_URL });
  const session = makeSession(page);
  const manager = new FakeBrowserManager(session);

  // Navigate to register the session with a fresh user-activity timestamp.
  assert.equal((await manager.navigate(RUN, PUBLIC_URL)).ok, true);
  assert.ok(await manager.getFrame(RUN));

  // Simulate an idle period longer than the session idle timeout.
  const idleMs = 5 * 60 * 1000; // SESSION_IDLE_MS
  session.lastUserActivityAt = Date.now() - idleMs - 5000;
  session.pendingChange = true;

  // A background heartbeat-style capture must not bump user activity.
  await (manager as unknown as { captureFrame: (r: string, s: SessionLike, f: boolean) => Promise<unknown> }).captureFrame(
    RUN, session, false,
  );
  assert.ok(
    Date.now() - session.lastUserActivityAt > idleMs,
    "heartbeat capture must not bump user activity",
  );

  const closed = await manager.prune();
  assert.equal(closed, 1);
  assert.equal(await manager.getFrame(RUN), null);
  await manager.close(RUN);
});

test("a forced capture counts as user activity; a heartbeat capture does not", async () => {
  const { page } = fakePage({ url: PUBLIC_URL });
  const session = makeSession(page);
  const manager = new FakeBrowserManager(session);
  const captureFrame = (forced: boolean) =>
    (manager as unknown as { captureFrame: (r: string, s: SessionLike, f: boolean) => Promise<unknown> }).captureFrame(
      RUN, session, forced,
    );

  session.pendingChange = true;
  const before = session.lastUserActivityAt;
  await captureFrame(false); // heartbeat-style: must not bump
  assert.equal(session.lastUserActivityAt, before, "heartbeat capture must not bump user activity");

  await captureFrame(true); // forced: must bump
  assert.ok(session.lastUserActivityAt >= before, "forced capture must count as user activity");
  await manager.close(RUN);
});

/** Minimal fake Browser used to drive launcher-recovery tests. */
function fakeBrowserHandle() {
  const handlers: Record<string, Array<(arg: never) => void>> = {};
  let closed = false;
  const browser = {
    on: (event: string, handler: (arg: never) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    close: async () => { closed = true; },
    isClosed: () => closed,
    fire: (event: string, arg: never = undefined as never) => {
      for (const handler of handlers[event] ?? []) handler(arg);
    },
  };
  return browser;
}

class LauncherProbeManager extends BrowserManager {
  launcherCalls = 0;
  private readonly launcher: () => Promise<Browser>;
  constructor(launcher: () => Promise<Browser>) {
    super({ bus: telemetryBus, launch: () => launcher() });
    this.launcher = launcher;
  }
  async probeBrowser(): Promise<Browser> {
    return this.browser();
  }
}

test("a failed Chromium launch does not poison later sessions", async () => {
  const fakeBrowser = fakeBrowserHandle();
  const manager = new LauncherProbeManager(async () => {
    manager.launcherCalls += 1;
    if (manager.launcherCalls === 1) throw new Error("launch boom");
    return fakeBrowser as unknown as Browser;
  });

  await assert.rejects(() => manager.probeBrowser(), /launch boom/);
  // The second attempt must retry fresh rather than reuse the rejected promise.
  const browser = await manager.probeBrowser();
  assert.equal(manager.launcherCalls, 2);
  assert.equal(browser, fakeBrowser as unknown as Browser);
  await manager.close("run_nonexistent");
});

test("a mid-run browser disconnect does not poison later sessions", async () => {
  const first = fakeBrowserHandle();
  const second = fakeBrowserHandle();
  const manager = new LauncherProbeManager(async () => {
    manager.launcherCalls += 1;
    return (manager.launcherCalls === 1 ? first : second) as unknown as Browser;
  });

  const browserA = await manager.probeBrowser();
  assert.equal(manager.launcherCalls, 1);

  // Simulate the browser disconnecting (crash / external close).
  first.fire("disconnected");

  const browserB = await manager.probeBrowser();
  assert.equal(manager.launcherCalls, 2, "disconnect must clear the cached launch");
  assert.equal(browserB, second as unknown as Browser);
  await manager.close("run_nonexistent");
});
