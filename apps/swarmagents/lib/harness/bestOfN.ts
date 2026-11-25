/**
 * Best-of-N across model families with oracle selection (master plan PR 1.2).
 *
 * On a non-trivial edit, dispatch the same edit to 2–3 candidates across
 * configured model families in parallel and take the first one that passes
 * the oracle gate. N and the family list are configurable per role
 * (RoleDefinition.bestOfN); env vars are the fallback for runs without a
 * role config.
 *
 * The oracle gate already knows how to judge several candidate diffs
 * (see ./oracle, modes "first" / "best"); this module is the missing half:
 * config resolution, the non-triviality test, and the parallel fan-out.
 *
 * Shape of a run (the manager's bounce path is the production caller):
 *   1. The primary agent finishes an edit; the post-run oracle rejects it.
 *   2. `shouldFanOutBestOfN` checks the role config + the primary diff.
 *      A trivial diff (a one-line fix, a single file touched) never fans
 *      out — the sequential bounce is cheaper and just as good there.
 *   3. `runBestOfN` runs one candidate per family in parallel. Each
 *      candidate is a full agent invocation in its own isolated scratch
 *      worktree (same prompt, different `--model`), so candidates never
 *      see each other's edits. A candidate that errors or produces no diff
 *      is skipped, not gated.
 *   4. The surviving diffs go to the oracle gate in "first" mode; the
 *      first passing candidate wins and its diff lands. Nothing passes →
 *      the caller falls back to the normal bounce (same model, remediation
 *      prompt).
 *
 * Fail-open throughout: a candidate failure, a gate error, or a bad config
 * never throws out of `runBestOfN` — it returns `winner: null` and the
 * caller carries on with the single-candidate path. Best-of-N is an
 * optimization on top of the oracle, never a new way for a run to die.
 *
 * Cost note: fanning out multiplies the token cost of a rejected edit by N,
 * so the feature is opt-in (disabled unless a role or env enables it with
 * N >= 2 and at least 2 families) and only triggers on non-trivial diffs.
 */

import { countChurn, parsePatchFiles } from "./oracle/diff";
import type { OracleCandidate, OracleReport } from "./oracle/oracle";
import { isModelFamily, modelFamily, type KnownModelFamily } from "../providers/model-family";
import type { RoleBestOfNConfig } from "../roles";

/** One candidate family: a model-family name, optionally pinned to a model. */
export interface BestOfNFamily {
  /** Family name, e.g. "deepseek" (see lib/providers/model-family.ts). */
  family: string;
  /** Concrete `--model` id. Absent = the family's default code model. */
  model?: string;
}

export interface BestOfNConfig {
  /** False unless N >= 2 and at least 2 families resolve. */
  enabled: boolean;
  /** Parallel candidates to dispatch. */
  n: number;
  /** Families, in dispatch order (first family = first candidate). */
  families: BestOfNFamily[];
  /** Oracle selection mode. */
  mode: "first" | "best";
}

/** The plan's example families (master-plan.md PR 1.2). */
export const DEFAULT_BEST_OF_N_FAMILIES: readonly string[] = ["deepseek", "qwen", "glm"];

export const DEFAULT_BEST_OF_N_N = 3;
export const DEFAULT_BEST_OF_N_MODE: "first" | "best" = "first";
/** A diff is non-trivial at 20 changed lines or more than one file. */
export const DEFAULT_BEST_OF_N_MIN_CHURN = 20;

/**
 * Default code model per family, from the provider catalog
 * (lib/providers/catalog.ts: deepseek default "deepseek-chat"; qwen coder
 * model "qwen3-coder-plus"; zai default "glm-4.5"). A role or env can pin a
 * different model per family with the "family:model" form.
 */
export const DEFAULT_MODEL_FOR_FAMILY: Readonly<Record<string, string>> = {
  deepseek: "deepseek-chat",
  qwen: "qwen3-coder-plus",
  glm: "glm-4.5",
};

/** The `--model` id for a family, or undefined when it has no known default. */
export function modelForFamily(family: BestOfNFamily): string | undefined {
  if (family.model) return family.model;
  return DEFAULT_MODEL_FOR_FAMILY[family.family.toLowerCase()];
}

/**
 * Parse one family spec. Accepts "deepseek", "deepseek:deepseek-chat", and
 * bare model ids ("deepseek-chat" → family deepseek). Returns null for
 * empty/unknown specs — unknown families are dropped, never fatal.
 */
export function parseBestOfNFamily(spec: unknown): BestOfNFamily | null {
  if (typeof spec !== "string") return null;
  const raw = spec.trim();
  if (!raw) return null;
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const family = raw.slice(0, colon).trim().toLowerCase();
    const model = raw.slice(colon + 1).trim();
    if (!family || !model) return null;
    return { family, model };
  }
  const lowered = raw.toLowerCase();
  if (isModelFamily(lowered as KnownModelFamily)) return { family: lowered };
  // A bare model id: the family is whatever family the model belongs to.
  const family = modelFamily(raw);
  if (family === "other") return null;
  return { family, model: raw };
}

/** Dedupe families by (family, model), keeping first-seen order. */
export function dedupeFamilies(families: readonly BestOfNFamily[]): BestOfNFamily[] {
  const seen = new Set<string>();
  const out: BestOfNFamily[] = [];
  for (const entry of families) {
    const key = `${entry.family.toLowerCase()}::${(entry.model ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function parseN(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

function parseMode(raw: unknown): "first" | "best" | undefined {
  return raw === "first" || raw === "best" ? raw : undefined;
}

/**
 * Env config: SWARM_BEST_OF_N (candidate count; 0/false disables),
 * SWARM_BEST_OF_N_FAMILIES (comma-separated family specs),
 * SWARM_BEST_OF_N_MODE ("first" | "best").
 */
export function bestOfNFromEnv(env: Record<string, string | undefined>): {
  n?: number;
  families?: BestOfNFamily[];
  mode?: "first" | "best";
  disabled?: boolean;
} {
  const out: { n?: number; families?: BestOfNFamily[]; mode?: "first" | "best"; disabled?: boolean } = {};
  const rawN = env.SWARM_BEST_OF_N;
  if (rawN !== undefined) {
    const lowered = rawN.trim().toLowerCase();
    if (lowered === "0" || lowered === "false" || lowered === "off") {
      out.disabled = true;
    } else {
      const n = parseN(rawN);
      if (n !== undefined) out.n = n;
    }
  }
  const rawFamilies = env.SWARM_BEST_OF_N_FAMILIES;
  if (rawFamilies !== undefined) {
    const families = dedupeFamilies(
      rawFamilies
        .split(",")
        .map((spec) => parseBestOfNFamily(spec))
        .filter((entry): entry is BestOfNFamily => entry !== null),
    );
    if (families.length > 0) out.families = families;
  }
  const mode = parseMode(env.SWARM_BEST_OF_N_MODE?.trim().toLowerCase());
  if (mode) out.mode = mode;
  return out;
}

/**
 * Resolve the effective config. Precedence per field: role config, then
 * env, then defaults. Enabled only when N >= 2 and at least 2 families
 * resolve — N = 1 is just the primary run, and a single family is not a
 * fan-out. An explicit env disable (SWARM_BEST_OF_N=0) beats a role
 * config: the operator can always switch the feature off.
 */
export function resolveBestOfNConfig(
  role: RoleBestOfNConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): BestOfNConfig {
  const fromEnv = bestOfNFromEnv(env);
  const roleFamilies =
    role?.families !== undefined
      ? dedupeFamilies(
          role.families.map((spec) => parseBestOfNFamily(spec)).filter((entry): entry is BestOfNFamily => entry !== null),
        )
      : undefined;
  const roleN = role?.n !== undefined ? parseN(role.n) : undefined;
  const roleMode = role?.mode !== undefined ? parseMode(role.mode) : undefined;
  const n = Math.min(3, Math.max(1, roleN ?? fromEnv.n ?? DEFAULT_BEST_OF_N_N));
  const families = (roleFamilies && roleFamilies.length > 0 ? roleFamilies : undefined) ??
    fromEnv.families ??
    DEFAULT_BEST_OF_N_FAMILIES.map((spec) => parseBestOfNFamily(spec)).filter(
      (entry): entry is BestOfNFamily => entry !== null,
    );
  const mode = roleMode ?? fromEnv.mode ?? DEFAULT_BEST_OF_N_MODE;
  const usableFamilies = dedupeFamilies(families).slice(0, n);
  const enabled = fromEnv.disabled !== true && n >= 2 && usableFamilies.length >= 2;
  return { enabled, n, families: usableFamilies, mode };
}

/**
 * Is this diff worth fanning out over? Non-trivial means either at least
 * `minChurn` added+removed lines, or more than one file touched. A
 * one-line fix in one file never fans out — the sequential bounce is
 * cheaper and just as good there.
 */
export function isNonTrivialDiff(
  diff: string,
  opts: { minChurn?: number } = {},
): boolean {
  if (!diff.trim()) return false;
  const minChurn = opts.minChurn ?? DEFAULT_BEST_OF_N_MIN_CHURN;
  if (countChurn(diff) >= minChurn) return true;
  return new Set(parsePatchFiles(diff).map((file) => file.path)).size > 1;
}

/** Pure decision helper for the manager's bounce path. */
export function shouldFanOutBestOfN(
  config: BestOfNConfig,
  diff: string | undefined | null,
): boolean {
  if (!config.enabled) return false;
  if (!diff) return false;
  return isNonTrivialDiff(diff);
}

export interface BestOfNDeps {
  /**
   * Run one candidate: same edit prompt, the family's model, in an
   * isolated scratch worktree. Returns the candidate's unified diff, or
   * null when the candidate produced nothing usable (error, abort, empty
   * diff). Must never throw for a candidate outcome.
   */
  runCandidate: (family: BestOfNFamily, index: number) => Promise<OracleCandidate | null>;
  /** Oracle-select among the surviving diffs (bound by the caller). */
  gate: (candidates: OracleCandidate[]) => Promise<OracleReport>;
  /** Telemetry sink for the fan-out log lines (never throws the run). */
  log?: (line: string) => void;
}

export interface BestOfNInput {
  families: readonly BestOfNFamily[];
}

export interface BestOfNOutcome {
  /** The winning candidate, or null when nothing passed (caller bounces). */
  winner: { id: string; family: BestOfNFamily; diff: string } | null;
  /** The oracle report, when candidates reached the gate. */
  report?: OracleReport;
  /** Candidates dispatched (families attempted). */
  attempted: number;
  /** Candidates that produced a diff and reached the gate. */
  gated: number;
  /** Candidate ids that produced no diff and were skipped. */
  skipped: string[];
  /** Gate infrastructure error (fail-open: winner stays null). */
  gateError?: string;
  /** "best-of-n: p/N candidates passed the oracle; winner <id>" (or none). */
  summary: string;
}

const candidateId = (family: BestOfNFamily, index: number): string =>
  `${family.family}-${index}`;

/**
 * Dispatch one candidate per family in parallel, oracle-gate the diffs
 * that come back, and return the first passing candidate ("first" mode) or
 * the passing one with the smallest churn ("best" mode — the gate decides;
 * this function just reads `landed[0]`).
 *
 * Never throws for a candidate or gate outcome: a candidate that errors
 * is skipped, a gate error returns `winner: null` with `gateError` set.
 * Only a bug in the caller's own callbacks (a non-Error throw is still
 * caught) can escape — and even that is reported, not thrown.
 */
export async function runBestOfN(deps: BestOfNDeps, input: BestOfNInput): Promise<BestOfNOutcome> {
  const families = [...input.families];
  const log = (line: string): void => {
    try {
      deps.log?.(line);
    } catch {
      // Logging must never break the fan-out.
    }
  };
  const skipped: string[] = [];
  let gated: { candidate: OracleCandidate; family: BestOfNFamily }[] = [];
  try {
    const settled = await Promise.allSettled(
      families.map(async (family, index) => {
        const id = candidateId(family, index);
        let candidate: OracleCandidate | null = null;
        try {
          candidate = await deps.runCandidate(family, index);
        } catch (error) {
          log(`best-of-n: candidate ${id} errored: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!candidate || !candidate.diff.trim()) {
          skipped.push(id);
          return null;
        }
        return { candidate, family };
      }),
    );
    gated = settled
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .filter((entry): entry is { candidate: OracleCandidate; family: BestOfNFamily } => entry !== null);
  } catch (error) {
    // Promise.allSettled itself cannot reject, but a hostile callback
    // environment still must not take the run down with it.
    const message = error instanceof Error ? error.message : String(error);
    return {
      winner: null,
      attempted: families.length,
      gated: 0,
      skipped,
      gateError: message,
      summary: `best-of-n: fan-out failed: ${message}`,
    };
  }

  if (gated.length === 0) {
    const summary = `best-of-n: 0/${families.length} candidates produced a diff`;
    log(summary);
    return { winner: null, attempted: families.length, gated: 0, skipped, summary };
  }

  let report: OracleReport;
  try {
    report = await deps.gate(gated.map((entry) => entry.candidate));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const summary = `best-of-n: oracle gate failed: ${message}`;
    log(summary);
    return { winner: null, attempted: families.length, gated: gated.length, skipped, gateError: message, summary };
  }

  const landedId = report.landed[0];
  const winnerEntry = landedId ? gated.find((entry) => entry.candidate.id === landedId) : undefined;
  const passed = report.verdicts.filter((verdict) => verdict.status === "passed").length;
  const winner = winnerEntry
    ? { id: winnerEntry.candidate.id, family: winnerEntry.family, diff: winnerEntry.candidate.diff }
    : null;
  const summary = winner
    ? `best-of-n: ${passed}/${gated.length} candidates passed the oracle; winner ${winner.id}`
    : `best-of-n: 0/${gated.length} candidates passed the oracle`;
  log(summary);
  return { winner, report, attempted: families.length, gated: gated.length, skipped, summary };
}
