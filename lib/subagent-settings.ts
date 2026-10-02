import fs from "node:fs";
import path from "node:path";
import { HOME, getProviders } from "./store";
import type { ProviderConfig } from "./types";

// SA3: the user's sub-agent preferences, stored under `subagents` in settings.json.
// The runtime (SA1, lib/subagents.ts) and the scheduler (SA2, lib/router.ts) read them through
// subagentPolicy(); the Settings UI reads and writes them through /api/settings/subagents.

export type SubagentMode = "off" | "auto" | "fixed";

export interface SubagentSettings {
  /** off: the agent never spawns sub-agents. auto: up to maxParallel at once, fewer when quota is short. fixed: exactly maxParallel. */
  mode: SubagentMode;
  /** 2–10. In auto it's the ceiling; in fixed it's the exact fan-out. */
  maxParallel: number;
  /** Which connection children run on: "same" follows the lead agent's routing, otherwise a provider id from Settings. */
  childProvider: string;
  /** Model override for children on that connection ("" = the connection's default model). */
  childModel: string;
  /** Total tokens (input + output) all children of one fan-out may use; null = no cap. */
  budgetTokens: number | null;
  /** Tool-call steps one child may take before it must report. */
  maxStepsPerChild: number;
}

export const SUBAGENT_DEFAULTS: SubagentSettings = {
  mode: "auto",
  maxParallel: 10,
  childProvider: "same",
  childModel: "",
  budgetTokens: null,
  maxStepsPerChild: 150,
};

export const PARALLEL_MIN = 2;
export const PARALLEL_MAX = 10;

const SETTINGS = path.join(HOME, "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Fills gaps and clamps whatever is stored (hand edits included) to valid values. */
export function normalizeSubagentSettings(raw: unknown): SubagentSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof SubagentSettings, unknown>>;
  const d = SUBAGENT_DEFAULTS;
  const mode = r.mode === "off" || r.mode === "auto" || r.mode === "fixed" ? r.mode : d.mode;
  const budget = r.budgetTokens == null || r.budgetTokens === "" ? null : Math.round(Number(r.budgetTokens));
  return {
    mode,
    maxParallel: clampInt(r.maxParallel, PARALLEL_MIN, PARALLEL_MAX, d.maxParallel),
    childProvider: typeof r.childProvider === "string" && r.childProvider.trim() ? r.childProvider.trim().slice(0, 80) : d.childProvider,
    childModel: typeof r.childModel === "string" ? r.childModel.trim().slice(0, 200) : d.childModel,
    budgetTokens: budget != null && Number.isFinite(budget) && budget > 0 ? Math.min(budget, 1_000_000_000) : null,
    maxStepsPerChild: clampInt(r.maxStepsPerChild, 5, 1000, d.maxStepsPerChild),
  };
}

export function getSubagentSettings(): SubagentSettings {
  return normalizeSubagentSettings(readSettings().subagents);
}

export class SubagentSettingsError extends Error {}

/** Validates a partial update, merges it over what's stored, and writes settings.json atomically (0600). */
export function saveSubagentSettings(patch: Partial<SubagentSettings>): SubagentSettings {
  const p = (patch ?? {}) as Record<string, unknown>;
  if (p.mode !== undefined && !["off", "auto", "fixed"].includes(String(p.mode))) throw new SubagentSettingsError("Mode must be off, auto or fixed.");
  if (p.maxParallel !== undefined) {
    const n = Number(p.maxParallel);
    if (!Number.isInteger(n) || n < PARALLEL_MIN || n > PARALLEL_MAX) throw new SubagentSettingsError(`Max parallel must be a whole number from ${PARALLEL_MIN} to ${PARALLEL_MAX}.`);
  }
  if (p.childProvider !== undefined && p.childProvider !== "same" && !getProviders().some((x) => x.id === p.childProvider))
    throw new SubagentSettingsError("That connection doesn't exist any more. Pick another in Settings → Models.");
  if (p.budgetTokens !== undefined && p.budgetTokens !== null) {
    const n = Number(p.budgetTokens);
    if (!Number.isFinite(n) || n < 1000) throw new SubagentSettingsError("Budget must be at least 1,000 tokens, or no cap.");
  }
  if (p.maxStepsPerChild !== undefined) {
    const n = Number(p.maxStepsPerChild);
    if (!Number.isInteger(n) || n < 5 || n > 1000) throw new SubagentSettingsError("Steps per sub-agent must be from 5 to 1000.");
  }
  const cur = readSettings();
  const next = normalizeSubagentSettings({ ...normalizeSubagentSettings(cur.subagents), ...p });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${SETTINGS}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...cur, subagents: next }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS);
  fs.chmodSync(SETTINGS, 0o600);
  return next;
}

export interface SubagentPolicy {
  enabled: boolean;
  mode: SubagentMode;
  /** How many children may run at once right now. 0 when disabled. */
  parallel: number;
  /** Children's connection (with childModel applied), or null to follow the lead agent's routing. */
  provider: ProviderConfig | null;
  budgetTokens: number | null;
  maxStepsPerChild: number;
  /** One line for the tool description / logs, e.g. "auto: up to 10 at once (6 now, quota)". */
  summary: string;
}

/**
 * What the runtime should do right now. `headroom` is the scheduler's (SA2) estimate of how many concurrent
 * requests the active providers can take without hitting rate or token limits; auto mode never exceeds it.
 * Fixed mode is the user's explicit choice, so headroom only throttles it to at least 1 (SA2 queues the rest).
 */
export function subagentPolicy(opts: { headroom?: number } = {}): SubagentPolicy {
  const s = getSubagentSettings();
  const provs = getProviders().filter((p) => p.enabled);
  const chosen = s.childProvider === "same" ? null : (provs.find((p) => p.id === s.childProvider) ?? null);
  const provider = chosen ? { ...chosen, model: s.childModel || chosen.model } : null;
  const head = opts.headroom != null && Number.isFinite(opts.headroom) ? Math.max(1, Math.floor(opts.headroom)) : undefined;
  if (s.mode === "off")
    return { enabled: false, mode: "off", parallel: 0, provider, budgetTokens: s.budgetTokens, maxStepsPerChild: s.maxStepsPerChild, summary: "off" };
  const parallel = s.mode === "fixed" ? s.maxParallel : Math.min(s.maxParallel, head ?? s.maxParallel);
  const summary =
    s.mode === "fixed"
      ? `fixed: ${s.maxParallel} at once`
      : `auto: up to ${s.maxParallel} at once${head != null && head < s.maxParallel ? ` (${parallel} now, limited by quota)` : ""}`;
  return { enabled: true, mode: s.mode, parallel, provider, budgetTokens: s.budgetTokens, maxStepsPerChild: s.maxStepsPerChild, summary };
}
