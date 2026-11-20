/**
 * The System-1 scorer: the cheap model that answers each gate's question.
 *
 * Omnexx talks a generic question/answer wire protocol to remote System-1
 * endpoints. The harness only needs five fixed questions, so the scorer is
 * a narrow interface with one method per gate. The local scorer answers
 * them from the calibrated features (no network, no keys) and is the
 * default. A remote scorer (a cheap model from the user's own provider
 * config) can implement the same interface; wrap it with `withFallback` so
 * an error or timeout drops to the local answer.
 *
 * Safety floors are NOT the scorer's job — the gates apply them on top of
 * whatever the scorer says (see ./gates.ts).
 */

import {
  completenessWeights,
  completionProb,
  destructiveProb,
  intentWeights,
  INTENT_KEYS,
  patchSignals,
  placeholderProb,
  triageWeights,
  TRIAGE_KEYS,
  type ContinuationState,
  type IntentClass,
  type TriageClass,
} from "./features";

export interface GuardrailInput {
  command: string;
  cwd: string;
  repoRoot: string;
  allowOutsideRepo: boolean;
}

export interface PatchInput {
  path: string;
  oldText: string;
  newText: string;
}

export interface PatchScore {
  /** P(the edit hides removed code behind placeholder comments). */
  placeholderProb: number;
  /** Completeness 1 (truncated) … 5 (clean). */
  completeness: number;
  /** Confidence in `completeness`, 0..1. */
  confidence: number;
}

export interface IntentScore {
  intent: IntentClass;
  confidence: number;
}

type MaybePromise<T> = T | Promise<T>;

export interface SystemOneScorer {
  /** Short backend label for telemetry, e.g. "calibrated-local". */
  readonly backend: string;
  destructive(input: GuardrailInput): MaybePromise<number>;
  patch(input: PatchInput): MaybePromise<PatchScore>;
  /** One class per chunk, same order. */
  triage(chunks: string[], tool: string): MaybePromise<TriageClass[]>;
  completion(state: ContinuationState): MaybePromise<number>;
  intent(prompt: string): MaybePromise<IntentScore>;
}

function argmax<K extends string>(keys: readonly K[], weights: Record<K, number>): { key: K; share: number } {
  const total = keys.reduce((n, k) => n + Math.max(0, weights[k] ?? 0), 0);
  let best = keys[0];
  for (const k of keys) if ((weights[k] ?? 0) > (weights[best] ?? 0)) best = k;
  return { key: best, share: total > 0 ? Math.max(0, weights[best] ?? 0) / total : 1 / keys.length };
}

/** Deterministic local scorer over the calibrated Omnexx features. */
export const localScorer: SystemOneScorer = {
  backend: "calibrated-local",
  destructive: (i) => destructiveProb(i.command, i.cwd, i.repoRoot, i.allowOutsideRepo),
  patch: (p) => {
    const sig = patchSignals(p.oldText, p.newText);
    const weights = completenessWeights(sig);
    const levels = ["0", "1", "2", "3", "4"] as const;
    const best = argmax(levels, { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, ...weights });
    return { placeholderProb: placeholderProb(sig), completeness: Number(best.key) + 1, confidence: best.share };
  },
  triage: (chunks) => chunks.map((chunk) => argmax(TRIAGE_KEYS, triageWeights(chunk)).key),
  completion: (state) => completionProb(state),
  intent: (prompt) => {
    const best = argmax(INTENT_KEYS, intentWeights(prompt));
    return { intent: best.key, confidence: best.share };
  },
};

/** Thrown when a scorer call exceeds its budget. */
export class SystemOneTimeoutError extends Error {
  constructor(ms: number) {
    super(`System-1 scorer exceeded ${ms}ms`);
    this.name = "SystemOneTimeoutError";
  }
}

/** Resolve `work` or reject after `ms`. */
export function withTimeout<T>(work: MaybePromise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(work),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new SystemOneTimeoutError(ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * `primary` with a per-call timeout; any error or timeout answers from
 * `fallback` instead (the local scorer by default). `onFallback` is told
 * which method fell back and why — never with prompt or file content.
 */
export function withFallback(
  primary: SystemOneScorer,
  options: { fallback?: SystemOneScorer; timeoutMs?: number; onFallback?: (method: string, error: unknown) => void } = {},
): SystemOneScorer {
  const fallback = options.fallback ?? localScorer;
  const ms = options.timeoutMs ?? 600;
  const wrap =
    <A extends unknown[], R>(method: string, call: (...a: A) => MaybePromise<R>, backup: (...a: A) => MaybePromise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await withTimeout(call(...args), ms);
      } catch (error) {
        try {
          options.onFallback?.(method, error);
        } catch {
          /* telemetry must not matter */
        }
        return await backup(...args);
      }
    };
  return {
    backend: `${primary.backend}+${fallback.backend}`,
    destructive: wrap("destructive", (i) => primary.destructive(i), (i) => fallback.destructive(i)),
    patch: wrap("patch", (p) => primary.patch(p), (p) => fallback.patch(p)),
    triage: wrap("triage", (c: string[], t: string) => primary.triage(c, t), (c: string[], t: string) => fallback.triage(c, t)),
    completion: wrap("completion", (s) => primary.completion(s), (s) => fallback.completion(s)),
    intent: wrap("intent", (p) => primary.intent(p), (p) => fallback.intent(p)),
  };
}
