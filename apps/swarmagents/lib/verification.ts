// Universal Phase-by-Phase Verification Pipeline
// Enforces that every task (code refactors, recipes, documents, analysis)
// satisfies explicit contract, milestone, and semantic acceptance gates before completion.

export type TaskDomain = "code" | "creative" | "recipe" | "analysis" | "general";

export interface VerificationTarget {
  taskType: TaskDomain;
  phase: "preflight_contract" | "incremental_milestone" | "semantic_acceptance";
  prompt: string;
  constraints?: string[];
  output: string;
  filesChanged?: string[];
  context?: Record<string, unknown>;
}

export type VerificationStatus = "passed" | "failed" | "verifier_error";

export interface VerificationResult {
  status: VerificationStatus;
  passed: boolean;
  score: number; // 0 - 100
  violations: string[];
  remediationPrompt?: string;
  metadata?: {
    phase: string;
    taskType: TaskDomain;
    timestamp: number;
  };
}

export type LLMCaller = (
  systemPrompt: string,
  userPrompt: string,
  options?: { signal?: AbortSignal },
) => Promise<string>;

const MAX_AUDIT_OUTPUT_CHARS = 12_000;

function boundAuditOutput(output: string, maxChars = MAX_AUDIT_OUTPUT_CHARS): string {
  if (output.length <= maxChars) return output;
  const marker = `\n\n[... output truncated for verification: showing first and last ${Math.floor(maxChars / 2)} chars of ${output.length} ...]\n\n`;
  const headLen = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  const tailLen = Math.max(0, maxChars - marker.length - headLen);
  return `${output.slice(0, headLen)}${marker}${output.slice(output.length - tailLen)}`;
}

function createAbortError(): Error {
  const err = new Error("Verification aborted");
  err.name = "AbortError";
  return err;
}

async function withVerificationTimeout<T>(
  work: (signal?: AbortSignal) => Promise<T>,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs;
  const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0;
  if (!opts?.signal && !hasTimeout) return work(undefined);

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let rejectTimeout: ((reason?: unknown) => void) | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const onAbort = () => {
    controller.abort(opts?.signal?.reason);
    rejectAbort?.(createAbortError());
  };

  if (opts?.signal) {
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
      throw createAbortError();
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const timeoutPromise = hasTimeout
    ? new Promise<never>((_, reject) => {
        rejectTimeout = reject;
        timer = setTimeout(() => {
          const err = new Error(`Verifier timed out after ${timeoutMs}ms`);
          controller.abort(err);
          reject(err);
        }, timeoutMs);
      })
    : null;

  const abortPromise = opts?.signal
    ? new Promise<never>((_, reject) => {
        rejectAbort = reject;
      })
    : null;

  try {
    const workPromise = work(controller.signal);
    const racers: Promise<T | never>[] = [workPromise];
    if (timeoutPromise) racers.push(timeoutPromise);
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
    // prevent unhandled rejections from unused racers
    void rejectTimeout;
    void rejectAbort;
  }
}

/**
 * Universal verification runner across all three phases:
 * Phase 1: Pre-Execution Contract Verification (did we understand constraints, tools, scope?)
 * Phase 2: Incremental Milestone Verification (syntax hygiene, proportions, step logic)
 * Phase 3: Semantic & Acceptance Verification (critic / auditor rubric evaluation)
 */
export async function verifyPhase(
  target: VerificationTarget,
  callLLM: LLMCaller,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<VerificationResult> {
  const phaseGuidance: Record<VerificationTarget["phase"], string> = {
    preflight_contract: `Phase 1: Pre-Execution Contract Verification.
Evaluate whether the proposed execution plan accurately captures all constraints, dependencies, risk levels, and bounds without skipping any requirement.`,
    incremental_milestone: `Phase 2: Incremental Milestone Verification.
Evaluate whether the intermediate output is internally consistent, free of syntax/execution/logical errors, correctly proportioned/ordered, and safe.`,
    semantic_acceptance: `Phase 3: Semantic & Acceptance Verification.
Act as the final Critic/Auditor. Check the final output against the original task specification and all constraints. Be rigorous and objective.`
  };

  const systemPrompt = `You are the Swarm Verification Harness Auditor.
Your job is to rigorously evaluate whether the completed phase satisfies all requirements and constraints.
You must be objective and strict. Whether evaluating code refactors, recipes, or documentation, check for:
1. Exact compliance with all stated constraints.
2. Internal consistency, safety, and correctness.
3. Absence of hallucinations, broken steps, or missing dependencies.

${phaseGuidance[target.phase]}

Output MUST be valid JSON with this exact schema:
{
  "passed": boolean,
  "score": number,
  "violations": string[],
  "remediationPrompt": string
}`;

  const userPrompt = `TASK SPECIFICATION:
${target.prompt}

PHASE BEING AUDITED:
${target.phase} (Domain: ${target.taskType})

CONSTRAINTS:
${(target.constraints || []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "None specified"}

OUTPUT TO AUDIT:
${boundAuditOutput(target.output)}

Audit the output against the specification. Return your evaluation in the required JSON format.`;

  try {
    const rawResponse = await withVerificationTimeout(
      (signal) => callLLM(systemPrompt, userPrompt, { signal }),
      opts,
    );
    const cleaned = rawResponse.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(cleaned);

    const violations = Array.isArray(parsed.violations)
      ? parsed.violations.filter((violation: unknown): violation is string => typeof violation === "string")
      : [];
    const passed = Boolean(parsed.passed && violations.length === 0);
    const remediation =
      typeof parsed.remediationPrompt === "string" && parsed.remediationPrompt.trim().length > 0
        ? parsed.remediationPrompt
        : passed
          ? undefined
          : "Address stated violations.";

    return {
      status: passed ? "passed" : "failed",
      passed,
      score: typeof parsed.score === "number" ? parsed.score : passed ? 100 : 0,
      violations,
      remediationPrompt: remediation,
      metadata: {
        phase: target.phase,
        taskType: target.taskType,
        timestamp: Date.now(),
      },
    };
  } catch {
    return {
      status: "verifier_error",
      passed: false,
      score: 0,
      violations: ["Verifier output was unparseable or malformed JSON"],
      remediationPrompt: "Re-run verification with strictly formatted JSON response.",
      metadata: {
        phase: target.phase,
        taskType: target.taskType,
        timestamp: Date.now(),
      },
    };
  }
}

/**
 * Executes a full 3-phase verification loop around an executor generator function.
 * If any phase fails verification, it bounces back to the generator with remediation prompt
 * and decrements the remaining budget until it passes or exhausts attempts.
 */
export async function executeWithPhaseVerification<T extends { output: string }>(opts: {
  taskType: TaskDomain;
  prompt: string;
  constraints?: string[];
  maxRemediations?: number;
  maxVerifierRetries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  callLLM: LLMCaller;
  generate: (remedy?: string) => Promise<T>;
}): Promise<{ result: T; audit: VerificationResult }> {
  const maxAttempts = opts.maxRemediations ?? 3;
  const maxVerifierRetries = Math.max(0, opts.maxVerifierRetries ?? 2);
  let lastRemedy: string | undefined;
  let lastAudit: VerificationResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw createAbortError();
    const candidate = await opts.generate(lastRemedy);

    let audit: VerificationResult | null = null;
    for (let verifierAttempt = 0; verifierAttempt <= maxVerifierRetries; verifierAttempt++) {
      if (opts.signal?.aborted) throw createAbortError();
      audit = await verifyPhase(
        {
          taskType: opts.taskType,
          phase: "semantic_acceptance",
          prompt: opts.prompt,
          constraints: opts.constraints,
          output: candidate.output,
        },
        opts.callLLM,
        { signal: opts.signal, timeoutMs: opts.timeoutMs },
      );
      if (audit.status !== "verifier_error") break;
      if (verifierAttempt === maxVerifierRetries) {
        throw new Error(
          `Verification infrastructure failed after ${maxVerifierRetries + 1} attempts: ${audit.violations.join(", ")}`,
        );
      }
    }

    if (!audit) {
      throw new Error("Verification did not produce an audit result");
    }

    if (audit.status === "passed") {
      return { result: candidate, audit };
    }

    lastAudit = audit;
    lastRemedy = `Attempt ${attempt} failed with violations: ${audit.violations.join("; ")}. Remediation: ${audit.remediationPrompt}`;
  }

  throw new Error(`Task failed verification after ${maxAttempts} attempts: ${lastAudit?.violations.join(", ")}`);
}
