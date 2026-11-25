/**
 * Declarative browser smoke/UI verification gate.
 *
 * Ported from vendor/omnexx/src/verify/browser-gate.ts and adapted to
 * SwarmAgents' SSRF-guarded `BrowserControl` (`lib/browser/manager.ts`) and
 * `ShadowExec` workspace reader — zero external YAML/TOML dependencies and zero
 * raw host-filesystem reads.
 */

import { posix as path } from "node:path";
import { z } from "zod";
import type { BrowserControl } from "../browser/manager";
import type { Failure, TestCounts } from "./parsers";
import type { GateLevel, GateResult } from "./ratchet";
import type { ShadowExec, ShadowVerificationSummary } from "./shadow-verifier";

export const browserStepSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("open"), url: z.string().min(1) }),
  z.strictObject({ action: z.literal("click"), selector: z.string().min(1) }),
  z.strictObject({ action: z.literal("type"), selector: z.string().min(1), text: z.string() }),
  z.strictObject({
    action: z.literal("expect_text"),
    text: z.string(),
    selector: z.string().optional(),
  }),
  z.strictObject({ action: z.literal("expect_selector"), selector: z.string().min(1) }),
  z.strictObject({ action: z.literal("expect_no_console_errors") }),
  z.strictObject({ action: z.literal("expect_nonempty") }),
  z.strictObject({ action: z.literal("fill"), selector: z.string().min(1), text: z.string() }),
  z.strictObject({ action: z.literal("select"), selector: z.string().min(1), value: z.string() }),
  z
    .strictObject({
      action: z.literal("wait_for"),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      timeout_ms: z.number().int().positive().optional(),
    })
    .refine((s) => (s.selector === undefined) !== (s.text === undefined), {
      message: "wait_for needs exactly one of selector or text",
    }),
  z.strictObject({ action: z.literal("expect_url"), url: z.string().min(1) }),
  z.strictObject({ action: z.literal("wait_ms"), ms: z.number().int().nonnegative() }),
]);

export type BrowserStep = z.infer<typeof browserStepSchema>;

export const browserGateFileSchema = z.strictObject({
  name: z.string().optional(),
  steps: z.array(browserStepSchema),
});

export type BrowserGateFile = z.infer<typeof browserGateFileSchema>;

export interface BrowserGateConfig {
  name: string;
  script?: string;
  url?: string;
  level?: GateLevel;
}

export interface BrowserGateBackend {
  readonly name: string;
  open(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  fill?(selector: string, text: string): Promise<void>;
  select?(selector: string, value: string): Promise<void>;
  waitFor?(target: { selector: string } | { text: string }, timeoutMs: number): Promise<void>;
  getUrl?(): Promise<string>;
  snapshot(): Promise<string>;
  hasSelector?(selector: string): Promise<boolean>;
  console(): Promise<Array<{ type: string; text: string }>>;
  close(): Promise<void>;
}

export interface BrowserGateContext {
  cwd: string;
  exec?: ShadowExec;
  readScript?: (scriptPath: string) => Promise<string>;
}

export const DEFAULT_BROWSER_GATE_STEPS: BrowserStep[] = [
  { action: "open", url: "${URL}" },
  { action: "wait_ms", ms: 500 },
  { action: "expect_nonempty" },
  { action: "expect_no_console_errors" },
];

const DEFAULT_WAIT_MS = 10_000;
const MIN_SNAPSHOT_CHARS = 40;

function parseScalar(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null" || val === "~") return null;
  if (/^-?\d+$/.test(val)) return Number.parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return Number.parseFloat(val);
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

/** Lightweight parser for YAML step lists (`steps:\n  - action: ...`). */
export function parseSimpleYaml(raw: string): Record<string, unknown> {
  const lines = raw.split("\n");
  const result: Record<string, unknown> = {};
  let currentKey = "";
  let inList = false;
  const listItems: Record<string, unknown>[] = [];
  let currentItem: Record<string, unknown> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ")) {
      inList = true;
      if (currentItem) listItems.push(currentItem);
      currentItem = {};
      const rest = trimmed.slice(2).trim();
      const colonIdx = rest.indexOf(":");
      if (colonIdx > 0) {
        currentItem[rest.slice(0, colonIdx).trim()] = parseScalar(rest.slice(colonIdx + 1).trim());
      }
      continue;
    }

    if (inList && (line.startsWith("    ") || line.startsWith("  "))) {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0 && currentItem) {
        currentItem[trimmed.slice(0, colonIdx).trim()] = parseScalar(
          trimmed.slice(colonIdx + 1).trim(),
        );
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      if (inList && currentKey) {
        if (currentItem) listItems.push(currentItem);
        currentItem = null;
        result[currentKey] = listItems;
        inList = false;
      }
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      currentKey = k;
      if (v) result[k] = parseScalar(v);
    }
  }

  if (inList && currentKey) {
    if (currentItem) listItems.push(currentItem);
    result[currentKey] = listItems;
  }

  return result;
}

/** Parse JSON or simple YAML browser-gate definitions into a validated `BrowserGateFile`. */
export function parseBrowserGateScript(raw: string): BrowserGateFile {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return browserGateFileSchema.parse(JSON.parse(trimmed));
  }
  return browserGateFileSchema.parse(parseSimpleYaml(raw));
}

/** Bridge SwarmAgents' SSRF-guarded `BrowserControl` onto `BrowserGateBackend`. */
export function createBrowserControlBackend(
  control: BrowserControl,
  runId: string,
): BrowserGateBackend {
  const assertOk = (res: { ok: boolean; reason?: string }, action: string) => {
    if (!res.ok) throw new Error(res.reason ?? `${action} failed`);
  };
  return {
    name: "swarm-browser-manager",
    async open(url) {
      const res = await control.navigate(runId, url);
      assertOk(res, "navigate");
    },
    async click(selector) {
      const res = await control.act(runId, { kind: "click", selector });
      assertOk(res, "click");
    },
    async type(selector, text) {
      const res = await control.act(runId, { kind: "type", selector, text });
      assertOk(res, "type");
    },
    async fill(selector, text) {
      const res = await control.act(runId, { kind: "type", selector, text, clear: true });
      assertOk(res, "fill");
    },
    async waitFor(target, timeoutMs) {
      if ("selector" in target) {
        const res = await control.act(runId, { kind: "wait", selector: target.selector });
        assertOk(res, "wait");
        return;
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const text = await this.snapshot();
        if (text.includes(target.text)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timed out waiting for text "${target.text}"`);
    },
    async getUrl() {
      const res = await control.evaluate(runId, "window.location.href");
      if (!res.ok) throw new Error(res.reason);
      return String(res.value ?? "");
    },
    async snapshot() {
      const res = await control.evaluate(
        runId,
        "document.body ? (document.body.innerText || document.body.textContent || '') : ''",
      );
      if (!res.ok) throw new Error(res.reason);
      return String(res.value ?? "");
    },
    async hasSelector(selector) {
      const res = await control.evaluate(
        runId,
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      );
      return res.ok && res.value === true;
    },
    async console() {
      const diags = await control.getDiagnostics(runId);
      return diags
        .filter((d) => d.kind === "console" || d.kind === "pageerror")
        .map((d) => ({
          type: d.kind === "pageerror" ? "error" : d.level,
          text: d.message,
        }));
    },
    async close() {
      await control.close(runId);
    },
  };
}

const unsupported = (backend: BrowserGateBackend, action: string): Error =>
  new Error(`the ${backend.name} browser backend does not support "${action}"`);

function resolveSafeScriptPath(cwd: string, script: string): string {
  if (path.isAbsolute(script)) throw new Error(`Script path must be relative: ${script}`);
  const joined = path.normalize(path.join(cwd, script));
  const base = path.normalize(cwd);
  if (!joined.startsWith(`${base}/`) && joined !== base) {
    throw new Error(`Script path escapes workspace: ${script}`);
  }
  return joined;
}

export async function runBrowserGate(
  gate: BrowserGateConfig,
  ctx: BrowserGateContext,
  backend: BrowserGateBackend | undefined,
): Promise<GateResult> {
  const startTime = Date.now();
  const level = gate.level ?? "ratchet";

  let parsedFile: BrowserGateFile;
  if (gate.script === undefined) {
    parsedFile = { steps: DEFAULT_BROWSER_GATE_STEPS };
  } else {
    let rawScript: string;
    try {
      const scriptPath = resolveSafeScriptPath(ctx.cwd, gate.script);
      if (ctx.readScript) {
        rawScript = await ctx.readScript(scriptPath);
      } else if (ctx.exec) {
        const res = await ctx.exec(["cat", "--", scriptPath], { cwd: ctx.cwd });
        if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `exit ${res.exitCode}`);
        rawScript = res.stdout;
      } else {
        throw new Error("no script reader or exec channel provided");
      }
    } catch (err) {
      return {
        name: gate.name,
        level,
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        failures: [
          {
            id: `${gate.name}:missing_script`,
            message: `Cannot read gate script "${gate.script}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        structured: true,
      };
    }

    try {
      parsedFile = parseBrowserGateScript(rawScript);
    } catch (err) {
      return {
        name: gate.name,
        level,
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        failures: [
          {
            id: `${gate.name}:syntax_error`,
            message: `Invalid gate script "${gate.script}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        structured: true,
      };
    }
  }

  if (!backend) {
    return {
      name: gate.name,
      level,
      exitCode: 1,
      timedOut: false,
      durationMs: Date.now() - startTime,
      failures: [{ id: `${gate.name}:no_backend`, message: "No browser backend available." }],
      structured: true,
    };
  }

  const failures: Failure[] = [];
  let passedCount = 0;
  const totalSteps = parsedFile.steps.length;

  try {
    for (let i = 0; i < parsedFile.steps.length; i++) {
      const step = parsedFile.steps[i];
      if (!step) continue;
      try {
        switch (step.action) {
          case "open":
            await backend.open(step.url.replaceAll("${URL}", gate.url ?? ""));
            passedCount++;
            break;
          case "click":
            await backend.click(step.selector);
            passedCount++;
            break;
          case "type":
            await backend.type(step.selector, step.text);
            passedCount++;
            break;
          case "fill":
            if (!backend.fill) throw unsupported(backend, step.action);
            await backend.fill(step.selector, step.text);
            passedCount++;
            break;
          case "select":
            if (!backend.select) throw unsupported(backend, step.action);
            await backend.select(step.selector, step.value);
            passedCount++;
            break;
          case "wait_for": {
            if (!backend.waitFor) throw unsupported(backend, step.action);
            const target =
              step.selector !== undefined ? { selector: step.selector } : { text: step.text ?? "" };
            await backend.waitFor(target, step.timeout_ms ?? DEFAULT_WAIT_MS);
            passedCount++;
            break;
          }
          case "expect_url": {
            if (!backend.getUrl) throw unsupported(backend, step.action);
            const want = step.url.replaceAll("${URL}", gate.url ?? "");
            const got = await backend.getUrl();
            if (!got.includes(want)) {
              throw new Error(`Expected URL containing "${want}", got "${got}"`);
            }
            passedCount++;
            break;
          }
          case "wait_ms":
            await new Promise((r) => setTimeout(r, step.ms));
            passedCount++;
            break;
          case "expect_text": {
            const snapshot = await backend.snapshot();
            if (!snapshot.includes(step.text)) {
              throw new Error(`Expected text "${step.text}" not found in snapshot`);
            }
            passedCount++;
            break;
          }
          case "expect_selector": {
            if (backend.hasSelector) {
              const found = await backend.hasSelector(step.selector);
              if (!found) throw new Error(`Expected element matching "${step.selector}" not found`);
            } else {
              const snapshot = await backend.snapshot();
              const target = step.selector.startsWith("@")
                ? step.selector
                : step.selector.replace(/^[#.[\]]/, "");
              if (!snapshot.includes(target) && !snapshot.includes(step.selector)) {
                throw new Error(`Expected element matching "${step.selector}" not found`);
              }
            }
            passedCount++;
            break;
          }
          case "expect_nonempty": {
            const snapshot = await backend.snapshot();
            if (snapshot.trim().length < MIN_SNAPSHOT_CHARS) {
              throw new Error(`Page looks empty (${snapshot.trim().length} chars)`);
            }
            passedCount++;
            break;
          }
          case "expect_no_console_errors": {
            const logs = await backend.console();
            const errors = logs.filter((l) => l.type === "error");
            if (errors.length > 0) {
              throw new Error(
                `Expected no console errors, found ${errors.length}: ${errors.map((e) => e.text).join("; ")}`,
              );
            }
            passedCount++;
            break;
          }
        }
      } catch (stepErr) {
        const msg = stepErr instanceof Error ? stepErr.message : String(stepErr);
        failures.push({
          id: `${gate.name}:step_${i + 1}_${step.action}`,
          message: `Step ${i + 1} (${step.action}) failed: ${msg}`,
        });
        break;
      }
    }
  } finally {
    await backend.close().catch(() => undefined);
  }

  const tests: TestCounts = {
    total: totalSteps,
    passed: passedCount,
    failed: failures.length,
    skipped: Math.max(0, totalSteps - passedCount - failures.length),
  };

  return {
    name: gate.name,
    level,
    exitCode: failures.length === 0 ? 0 : 1,
    timedOut: false,
    durationMs: Date.now() - startTime,
    failures,
    tests,
    structured: true,
  };
}

const REPO_BROWSER_GATE_FILES = new Set([
  ".swarm/browser-gate.yaml",
  ".swarm/browser-gate.yml",
  ".swarm/browser-gate.json",
]);

/**
 * Run `.swarm/browser-gate.{yaml,yml,json}` when present inside `repoRoot`.
 * Returns `null` when no gate script exists, when it passes, or when an
 * infrastructure failure occurs (fail-open so missing Playwright never blocks runs).
 */
export async function runRepoBrowserGate(
  exec: ShadowExec,
  repoRoot: string,
  makeBackend: () => BrowserGateBackend | undefined,
  url?: string,
): Promise<ShadowVerificationSummary | null> {
  try {
    const probe = await exec(
      [
        "sh",
        "-c",
        'for f in .swarm/browser-gate.yaml .swarm/browser-gate.yml .swarm/browser-gate.json; do if [ -f "$f" ]; then printf %s "$f"; exit 0; fi; done',
      ],
      { cwd: repoRoot },
    );
    const script = probe.stdout.trim();
    if (probe.exitCode !== 0 || !REPO_BROWSER_GATE_FILES.has(script)) {
      return null;
    }
    const backend = makeBackend();
    if (!backend) return null;
    const result = await runBrowserGate(
      { name: "browser-gate", script, url },
      { cwd: repoRoot, exec },
      backend,
    );
    if (result.exitCode === 0) return null;
    const violations = result.failures.map((f) => f.message);
    return {
      passed: false,
      score: 0,
      badge: "fail",
      violations,
      remediationPrompt: `Browser gate (${script}) failed:\n${violations.map((v) => `- ${v}`).join("\n")}`,
      testsRan: true,
      buildBroke: false,
    };
  } catch {
    return null;
  }
}
