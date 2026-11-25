/**
 * Adversarial QA gate (master-plan PR 2.2).
 *
 * When the builder marks a task done, an independent QA role on a *different*
 * model family tests the live app against the acceptance criteria and blocks
 * completion with screenshots and HTTP traces on failure.
 *
 * Independence is enforced by construction, in three places:
 *
 *   1. Different family. The QA caller is built from providers whose
 *      fast-tier model belongs to a different model family than the
 *      builder's model (`selectQaProviders`). When no different-family
 *      provider is configured, the gate cannot run and is skipped — it
 *      never grades the builder with the builder's own family.
 *   2. Blind context. The QA prompt (`buildQaPrompts`) contains only the
 *      acceptance criteria, the app URL, and the captured HTTP traces /
 *      screenshot notes. The builder's chat, diff, and run log are never
 *      inputs: the function signature has no parameter that could carry
 *      them.
 *   3. Evidence, not assertion. A failure blocks with the HTTP traces and
 *      screenshot labels that prove it; the remediation prompt sent back
 *      to the builder carries those traces, never the QA model's internals.
 *
 * The module is deliberately dependency-injected and pure, like the shadow
 * verifier: the manager wires the fetch driver, the browser screenshot,
 * and the QA-model caller in, and unit tests inject fakes. Any
 * infrastructure failure (no QA provider, probe error, unparseable
 * verdict) skips the gate instead of blocking or bouncing a run — the
 * same fail-open philosophy as the shadow gate.
 */

import { orderProvidersByCost } from "../lenses/run";
import { modelForTier } from "../providers/adapters";
import { modelFamily, type ModelFamily } from "../providers/model-family";
import type { ProviderConfig } from "../providers/types";
import type { LLMCaller } from "../verification";
import {
  SHADOW_VERIFIER_MIN_PASS_SCORE,
  type ShadowVerificationSummary,
} from "./shadow-verifier";

/** Token cap for the QA judge call. */
export const ADVERSARIAL_QA_MAX_TOKENS = 2048;
/** Per-probe HTTP timeout. */
export const ADVERSARIAL_QA_PROBE_TIMEOUT_MS = 15_000;
/** Live app under test when no override is configured. */
export const ADVERSARIAL_QA_DEFAULT_APP_URL = "https://swarmagents.codes";
/** Cap on the response body read per probe (traces carry status, not bodies). */
export const ADVERSARIAL_QA_MAX_PROBE_BYTES = 256 * 1024;

/** The adversarial QA gate is opt-in until its run-time cost is proven. */
export function adversarialQaEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.SWARM_ADVERSARIAL_QA?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * App URL the QA gate tests. Operators can point a deploy pipeline at a
 * branch preview with SWARM_ADVERSARIAL_QA_URL; otherwise the gate tests
 * the live app, exactly as PR 2.2 specifies.
 */
export function adversarialQaAppUrl(env: Record<string, string | undefined> = process.env): string {
  const override = env.SWARM_ADVERSARIAL_QA_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  return ADVERSARIAL_QA_DEFAULT_APP_URL;
}

/** One HTTP probe of the live app. Bodies are never stored — status only. */
export interface HttpTrace {
  label: string;
  url: string;
  method: string;
  /** 0 when the request never reached the server. */
  status: number;
  ok: boolean;
  latencyMs: number;
  bytes: number;
  error?: string;
}

/** Screenshot evidence: the frame lives in the run stream; the summary keeps the label. */
export interface QaScreenshotEvidence {
  label: string;
  url: string;
  ok: boolean;
  reason?: string;
}

export interface AdversarialQaSummary extends ShadowVerificationSummary {
  /** Provider/model/family that served the QA verdict. */
  qaProvider?: string;
  qaModel?: string;
  qaFamily?: ModelFamily;
  /** HTTP traces captured while probing the live app. */
  httpTraces: HttpTrace[];
  /** Screenshot outcomes (frames are in the run stream, not inline). */
  screenshots: QaScreenshotEvidence[];
  /**
   * Criteria the QA judge could not verify from the live-app evidence.
   * Reported, never silently passed — but they do not fail the gate on
   * their own, or criteria no HTTP trace can prove would bounce forever.
   */
  unverifiable: string[];
}

/**
 * QA providers for a builder running `builderModel`: the account's
 * providers ordered cheapest-first, restricted to those whose fast-tier
 * model belongs to a different family than the builder's. An unknown
 * builder model counts as family "other", so only providers with a known,
 * different family qualify — a family that cannot be proven different is
 * never used as the independent check.
 */
export function selectQaProviders(
  providers: readonly ProviderConfig[],
  builderModel: string | undefined,
): ProviderConfig[] {
  const builderFamily = modelFamily(builderModel ?? undefined);
  return orderProvidersByCost(providers).filter((config) => {
    const qaFamily = modelFamily(modelForTier(config, "fast"));
    return qaFamily !== builderFamily;
  });
}

export interface AdversarialQaDeps {
  /** QA-model caller, already bound to a different-family provider. */
  callLLM: LLMCaller;
  /** Probe one URL and return its trace (never throws for HTTP errors). */
  fetchUrl: (url: string) => Promise<HttpTrace>;
  /**
   * Screenshot one URL in a headed browser. Optional: when no driver is
   * wired, the gate still runs on HTTP traces and records the gap.
   */
  screenshot?: (url: string) => Promise<{ ok: true; label: string } | { ok: false; reason: string }>;
  /** Observable log lines (the manager publishes these to the run log). */
  log?: (line: string) => void;
}

export interface AdversarialQaCheck {
  label: string;
  url: string;
}

export interface AdversarialQaContext {
  /** Acceptance criteria, verbatim from the task — the only spec the QA sees. */
  acceptanceCriteria: string;
  /** App URL under test. */
  appUrl: string;
  /** Same-origin routes to probe (app URL itself, health endpoint, ...). */
  checks: AdversarialQaCheck[];
  qaProvider: string;
  qaModel: string;
  qaFamily: ModelFamily;
  signal?: AbortSignal;
}

const QA_SYSTEM_PROMPT =
  "You are an independent QA tester. You did not build this app and you have never seen the builder's work, chat, or code. " +
  "You judge ONLY what the live app observably does against the acceptance criteria below, using the HTTP traces and screenshot notes provided. " +
  "Fail a criterion only when the evidence contradicts it. List criteria the evidence cannot prove either way as unverifiable — never guess. " +
  "Reply with a single JSON object and nothing else: " +
  '{"passed": boolean, "score": 0-100, "violations": ["..."], "unverifiable": ["..."], "remediationPrompt": "what the builder must fix, or omit when passing"}.';

/**
 * Build the QA judge prompts. Blind by construction: the only inputs are
 * the acceptance criteria, the app URL, and the captured evidence. There
 * is no parameter for builder chat, diffs, or run logs.
 */
export function buildQaPrompts(
  acceptanceCriteria: string,
  appUrl: string,
  traces: HttpTrace[],
  screenshots: QaScreenshotEvidence[],
): { system: string; user: string } {
  const traceLines = traces.map((trace) =>
    trace.error
      ? `- ${trace.label}: ${trace.method} ${trace.url} -> ERROR after ${trace.latencyMs}ms (${trace.error})`
      : `- ${trace.label}: ${trace.method} ${trace.url} -> HTTP ${trace.status} ${trace.ok ? "ok" : "FAIL"} in ${trace.latencyMs}ms (${trace.bytes} bytes)`,
  );
  const shotLines =
    screenshots.length > 0
      ? screenshots.map((shot) =>
          shot.ok
            ? `- ${shot.label} (${shot.url})`
            : `- screenshot of ${shot.url} FAILED: ${shot.reason ?? "unknown error"}`,
        )
      : ["- (no screenshots captured)"];
  const user =
    `Live app under test: ${appUrl}\n\n` +
    `Acceptance criteria:\n${acceptanceCriteria}\n\n` +
    `HTTP traces:\n${traceLines.join("\n")}\n\n` +
    `Screenshots:\n${shotLines.join("\n")}\n\n` +
    `Judge each criterion against this evidence only.`;
  return { system: QA_SYSTEM_PROMPT, user };
}

interface QaVerdict {
  passed: boolean;
  score: number;
  violations: string[];
  unverifiable: string[];
  remediationPrompt?: string;
}

/** Parse a QA judge verdict; null when the response is not a valid verdict. */
export function parseQaVerdict(raw: string): QaVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) return null;
  if (!Array.isArray(obj.violations) || obj.violations.some((v) => typeof v !== "string")) return null;
  if (
    obj.unverifiable !== undefined &&
    (!Array.isArray(obj.unverifiable) || obj.unverifiable.some((v) => typeof v !== "string"))
  ) {
    return null;
  }
  if (obj.remediationPrompt !== undefined && typeof obj.remediationPrompt !== "string") return null;
  return {
    passed: obj.passed,
    score: Math.max(0, Math.min(100, Math.round(obj.score))),
    violations: obj.violations as string[],
    unverifiable: (obj.unverifiable as string[] | undefined) ?? [],
    ...(typeof obj.remediationPrompt === "string" && obj.remediationPrompt.trim()
      ? { remediationPrompt: obj.remediationPrompt }
      : {}),
  };
}

function traceSummary(traces: HttpTrace[]): string {
  return traces
    .map((trace) =>
      trace.error
        ? `${trace.label}: ${trace.method} ${trace.url} -> ERROR (${trace.error})`
        : `${trace.label}: ${trace.method} ${trace.url} -> HTTP ${trace.status} in ${trace.latencyMs}ms`,
    )
    .join("\n");
}

/**
 * Run one adversarial QA round.
 *
 *   1. Probe the live app (HTTP traces) and screenshot it when a driver
 *      is wired. A failed probe blocks completion outright — the live app
 *      not responding is itself the failure, with the trace as evidence,
 *      and no judge call is spent guessing at a down app.
 *   2. Send the criteria + traces to the QA model on the different family.
 *   3. Return the summary, or undefined when the gate could not run
 *      (judge call failed, verdict unparseable): the run is never blocked
 *      by QA infrastructure.
 */
export async function runAdversarialQa(
  deps: AdversarialQaDeps,
  ctx: AdversarialQaContext,
): Promise<AdversarialQaSummary | undefined> {
  const log = deps.log ?? (() => {});
  const base: Omit<AdversarialQaSummary, "passed" | "score" | "badge" | "violations" | "testsRan" | "buildBroke"> = {
    qaProvider: ctx.qaProvider,
    qaModel: ctx.qaModel,
    qaFamily: ctx.qaFamily,
    httpTraces: [],
    screenshots: [],
    unverifiable: [],
  };
  log(`qa: independent check by ${ctx.qaProvider}/${ctx.qaModel} (family ${ctx.qaFamily}, builder family excluded)`);
  const traces: HttpTrace[] = [];
  for (const check of ctx.checks) {
    if (ctx.signal?.aborted) return undefined;
    const trace = await deps.fetchUrl(check.url);
    trace.label = check.label;
    traces.push(trace);
  }
  base.httpTraces = traces;
  const failedProbe = traces.find((trace) => !trace.ok);
  if (deps.screenshot) {
    try {
      const shot = await deps.screenshot(ctx.appUrl);
      base.screenshots = [
        shot.ok
          ? { label: shot.label, url: ctx.appUrl, ok: true }
          : { label: "screenshot failed", url: ctx.appUrl, ok: false, reason: shot.reason },
      ];
    } catch (error) {
      base.screenshots = [
        {
          label: "screenshot failed",
          url: ctx.appUrl,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }
  for (const trace of traces) {
    log(
      trace.error
        ? `qa: probe ${trace.label} ${trace.method} ${trace.url} -> ERROR (${trace.error})`
        : `qa: probe ${trace.label} ${trace.method} ${trace.url} -> HTTP ${trace.status} in ${trace.latencyMs}ms`,
    );
  }
  if (failedProbe) {
    const violations = traces
      .filter((trace) => !trace.ok)
      .map((trace) =>
        trace.error
          ? `QA probe failed: ${trace.label} ${trace.method} ${trace.url} errored (${trace.error})`
          : `QA probe failed: ${trace.label} ${trace.method} ${trace.url} returned HTTP ${trace.status}`,
      );
    log(`qa: BLOCKED — live app probe failed (${violations.length} failing probe${violations.length === 1 ? "" : "s"})`);
    return {
      ...base,
      passed: false,
      score: 0,
      badge: "fail",
      violations,
      testsRan: true,
      buildBroke: true,
      remediationPrompt:
        `Adversarial QA (${ctx.qaProvider}/${ctx.qaModel}) blocked completion: the live app did not answer its probes.\n` +
        `${violations.join("\n")}\n\nHTTP traces:\n${traceSummary(traces)}\n\n` +
        `Fix the live app so its probes answer, then resubmit.`,
    };
  }
  const { system, user } = buildQaPrompts(ctx.acceptanceCriteria, ctx.appUrl, traces, base.screenshots);
  let raw: string;
  try {
    raw = await deps.callLLM(system, user, ctx.signal ? { signal: ctx.signal } : undefined);
  } catch {
    log("qa: judge call failed — skipping adversarial QA");
    return undefined;
  }
  const verdict = parseQaVerdict(raw);
  if (!verdict) {
    log("qa: judge verdict unparseable — skipping adversarial QA");
    return undefined;
  }
  log(
    verdict.passed
      ? `qa: PASSED (${verdict.score}/100${verdict.unverifiable.length > 0 ? `, ${verdict.unverifiable.length} unverifiable` : ""})`
      : `qa: BLOCKED — ${verdict.violations.length} violation${verdict.violations.length === 1 ? "" : "s"} (${verdict.score}/100)`,
  );
  return {
    ...base,
    passed: verdict.passed,
    score: verdict.score,
    badge: verdict.passed ? (verdict.score >= SHADOW_VERIFIER_MIN_PASS_SCORE ? "pass" : "warn") : "fail",
    violations: verdict.passed ? [] : verdict.violations,
    unverifiable: verdict.unverifiable,
    testsRan: true,
    buildBroke: false,
    ...(verdict.passed
      ? {}
      : {
          remediationPrompt:
            verdict.remediationPrompt ??
            `Adversarial QA (${ctx.qaProvider}/${ctx.qaModel}) blocked completion:\n` +
              `${verdict.violations.map((v) => `- ${v}`).join("\n")}\n\nHTTP traces:\n${traceSummary(traces)}` +
              (verdict.unverifiable.length > 0
                ? `\n\nCriteria the QA could not verify from the live app: ${verdict.unverifiable.join("; ")}`
                : ""),
        }),
  };
}
