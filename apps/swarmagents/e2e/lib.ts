import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export type E2EMode = "local" | "prod";

export interface SummaryEntry {
  test: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
  screenshot?: string;
}

export interface PageTestContext {
  page: Page;
  context: BrowserContext;
  consoleErrors: string[];
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3777";
const DEFAULT_SCREENSHOT_ROOT = "/workspace/swarmagents-playtest";
const RUN_MARKER_TTL_MS = 60_000;

export class UISkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UISkipError";
  }
}

export function mode(): E2EMode {
  return process.env.SWARM_E2E_MODE === "prod" ? "prod" : "local";
}

export function baseUrl(): string {
  return (process.env.BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(lockPath: string, action: () => T): T {
  const deadline = Date.now() + 3_000;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      sleepSync(25);
    }
  }
  try {
    return action();
  } finally {
    if (acquired) fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export function screenshotDir(): string {
  const configured = process.env.SCREENSHOT_DIR?.trim();
  if (configured) {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  }

  fs.mkdirSync(DEFAULT_SCREENSHOT_ROOT, { recursive: true });
  const marker = path.join(DEFAULT_SCREENSHOT_ROOT, ".current-run.json");
  return withLock(`${marker}.lock`, () => {
    try {
      const current = JSON.parse(fs.readFileSync(marker, "utf8")) as { dir?: string; created?: number };
      if (
        typeof current.dir === "string" &&
        typeof current.created === "number" &&
        Date.now() - current.created < RUN_MARKER_TTL_MS &&
        fs.existsSync(current.dir)
      ) {
        return current.dir;
      }
    } catch {}

    const created = Date.now();
    const dir = path.join(DEFAULT_SCREENSHOT_ROOT, new Date(created).toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ dir, created }), "utf8");
    return dir;
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function redact(value: string): string {
  const token = process.env.SWARM_HARNESS_TOKEN;
  return token ? value.split(token).join("[redacted]") : value;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.stack ?? err.message : String(err);
  return redact(text);
}

export function record(entry: SummaryEntry): void {
  const dir = screenshotDir();
  const file = path.join(dir, "summary.json");
  withLock(`${file}.lock`, () => {
    let entries: SummaryEntry[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) entries = parsed as SummaryEntry[];
    } catch {}

    const index = entries.findIndex((item) => item.test === entry.test);
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    entries.sort((a, b) => a.test.localeCompare(b.test));

    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  });
}

let browserPromise: Promise<Browser> | undefined;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const executablePath = process.env.PW_CHROMIUM_PATH?.trim() || chromium.executablePath();
    browserPromise = chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = undefined;
  await browser.close();
}

export interface RunPageTestOptions {
  /** Override the default 1440x1000 desktop viewport (e.g. a phone size). */
  viewport?: { width: number; height: number };
}

export async function runPageTest(
  testName: string,
  fn: (ctx: PageTestContext) => Promise<void>,
  options: RunPageTestOptions = {},
): Promise<{ skipped?: string }> {
  const browser = await getBrowser();
  const token = process.env.SWARM_HARNESS_TOKEN;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  const context = await browser.newContext({
    baseURL: baseUrl(),
    extraHTTPHeaders: headers,
    viewport: options.viewport ?? { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    try {
      // SwarmIntro persists this in localStorage; setting the session key
      // alone left the onboarding overlay up and could swallow the landing
      // "Launch Agent Workspace" click.
      localStorage.setItem("sa.intro.seen", "1");
      sessionStorage.setItem("sa.intro.seen", "1");
      // SwarmIntro remembers the dismissal in localStorage (the workspace
      // itself is addressed by the `#view=computer` hash).
      localStorage.setItem("sa.intro.seen", "1");
    } catch {}
  });

  if (mode() === "prod") {
    await context.route("**/*", async (route) => {
      const method = route.request().method();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") await route.continue();
      else await route.abort();
    });
  }

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(redact(err.message)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (msg.location().url.endsWith("/favicon.ico")) return;
    consoleErrors.push(redact(msg.text()));
  });

  const screenshot = path.join(screenshotDir(), `${slug(testName)}.png`);
  let failure: unknown;
  let skipped: string | undefined;
  try {
    await fn({ page, context, consoleErrors });
  } catch (err) {
    if (err instanceof UISkipError) skipped = err.message;
    else {
      failure = err;
      throw err;
    }
  } finally {
    let captured: string | undefined;
    if (!page.isClosed()) {
      try {
        await page.screenshot({ path: screenshot, fullPage: true });
        captured = screenshot;
      } catch {}
    }
    try {
      record({
        test: testName,
        status: failure ? "failed" : skipped ? "skipped" : "passed",
        error: failure ? errorText(failure) : skipped,
        screenshot: captured,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  return skipped ? { skipped } : {};
}

export async function isLoginWall(page: Page): Promise<boolean> {
  try {
    const url = new URL(page.url());
    if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return true;
  } catch {}
  const loginForm = page.locator("form.login-form, .login-page, input[type='password']").first();
  return loginForm.isVisible().catch(() => false);
}

async function tryAuthenticateReadOnly(context: BrowserContext): Promise<boolean> {
  // Prod mode blocks non-GET page navigations; token-to-session exchange would
  // require a supported API flow (e.g. POST) which is not available here.
  void context;
  return false;
}

export async function assertUIAccessible(page: Page, context: BrowserContext): Promise<void> {
  if (mode() !== "prod") return;
  if (!(await isLoginWall(page))) return;

  const authed = await tryAuthenticateReadOnly(context);
  if (authed) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    if (!(await isLoginWall(page))) return;
  }

  throw new UISkipError(
    "UI skipped: prod sign-in wall detected at /login and no supported read-only token-to-session mechanism is available (bearer SWARM_HARNESS_TOKEN does not authenticate page navigations).",
  );
}

export async function openWorkspace(
  page: Page,
  context?: BrowserContext,
  options: { devMode?: boolean } = {},
): Promise<void> {
  // A fresh account has no provider, so the workspace shows first-run setup
  // instead of the hero/conversation: register the fake provider first (local
  // mode only; the fake VM replays a recorded transcript instead of calling
  // it). Without this, whichever spec runs first on a fresh server times out
  // waiting for the hero or the conversation log.
  if (mode() === "local") await ensureFakeProvider(page);

  // The workspace is the home page: one shell with the chat, the computer's
  // screen and the board. There is no landing page or intro in front of it.
  // The Board view is dev-mode only (?dev=1 turns it on, persisted per
  // browser), so specs that exercise it navigate with the flag.
  const url = options.devMode ? "/?dev=1" : "/";
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (response && response.status() >= 400) throw new Error(`Home page returned HTTP ${response.status()}`);

  if (context) await assertUIAccessible(page, context);

  // The composer and computer are present regardless of the selected workspace tab.
  await page.getByTestId("minimal-main-page").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("composer-input").waitFor({ state: "visible", timeout: 15_000 });

}

/**
 * A fake provider for the local account: a local stub URL that is never
 * actually called — the local fake VM replays a recorded transcript instead
 * of talking to a provider. Registering it is what keeps a fresh account out
 * of first-run setup, so the workspace loads with the hero/conversation.
 */
export const FAKE_PROVIDER = {
  id: "fake-e2e",
  apiStyle: "openai-compatible",
  baseUrl: "http://127.0.0.1:9/v1",
  models: ["fake-model"],
  apiKey: "sk-fake-e2e",
  isFree: false,
  inputPricePer1mTokens: 1000,
  outputPricePer1mTokens: 1000,
};

/** Register the fake provider for the local account (idempotent upsert). */
export async function ensureFakeProvider(page: Page): Promise<void> {
  const saved = await page.request.post("/api/providers", { data: FAKE_PROVIDER });
  if (!saved.ok()) {
    throw new Error(`could not register the fake provider: HTTP ${saved.status()} ${await saved.text()}`);
  }
}

/**
 * Start from an empty conversation. The e2e server keeps one account, so a
 * fresh browser context reopens whatever conversation ran last.
 */
export async function startNewChat(page: Page): Promise<void> {
  const newChat = page.getByTestId("new-chat");
  // New chat is disabled while a run from an earlier spec is still winding down.
  // Function predicate, not a string: the app's CSP blocks eval, which is how
  // Playwright evaluates string predicates (see waitForLastTurn below).
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="new-chat"]') as HTMLButtonElement | null;
      return !el?.disabled;
    },
    undefined,
    { timeout: 60_000 },
  );
  await newChat.click();
  await page.getByTestId("conversation-empty").waitFor({ state: "visible", timeout: 15_000 });
}

/** Send a message from the composer. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
}

/** Wait until the newest turn in the conversation is in `phase` (finished, error, cancelled, ...). */
export async function waitForLastTurn(page: Page, phase: string, timeout = 60_000): Promise<void> {
  // Function predicate with the phase as an argument, not a string: the app's
  // CSP (script-src 'self' + nonce, no 'unsafe-eval') blocks the eval
  // Playwright uses for string predicates, so the string form throws
  // EvalError on every call.
  await page.waitForFunction(
    (wanted) => {
      const turns = document.querySelectorAll('[data-testid="turn"]');
      const last = turns[turns.length - 1];
      return Boolean(last) && last.getAttribute("data-phase") === wanted;
    },
    phase,
    { timeout },
  );
}

export async function captureView(page: Page, testName: string, label: string): Promise<string> {
  const file = path.join(screenshotDir(), `${slug(testName)}-${slug(label)}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
