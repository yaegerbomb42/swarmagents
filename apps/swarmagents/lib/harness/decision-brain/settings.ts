/**
 * Decision Brain settings. Everything is OFF unless a user/run setting
 * turns it on: `enabled` is the master switch. Mirrors the System-1
 * settings shape (resolve*Settings, invalid values fall back to
 * defaults instead of throwing — a bad setting must never block a run).
 */

export interface DecisionBrainSettings {
  /** Master switch. False → every hook is a no-op pass-through. */
  enabled: boolean;
  /** Local-decision confidence below which the router escalates. */
  confidenceThreshold: number;
  /** Per-evaluation budget; a slower router is treated as an error (fail-open). */
  hookTimeoutMs: number;
  /** Tool-call evaluations before the heuristic stops the run on budget. */
  maxTurns: number;
}

export const DEFAULT_DECISION_BRAIN_SETTINGS: Readonly<DecisionBrainSettings> =
  Object.freeze({
    enabled: false,
    confidenceThreshold: 0.75,
    hookTimeoutMs: 1500,
    maxTurns: 50,
  });

export type DecisionBrainSettingsInput = Partial<DecisionBrainSettings>;

const unit = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;

export function resolveDecisionBrainSettings(
  input: DecisionBrainSettingsInput | null | undefined = {},
): DecisionBrainSettings {
  const d = DEFAULT_DECISION_BRAIN_SETTINGS;
  const i = input ?? {};
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;
  return {
    enabled: flag(i.enabled, d.enabled),
    confidenceThreshold: unit(i.confidenceThreshold, d.confidenceThreshold),
    hookTimeoutMs:
      typeof i.hookTimeoutMs === "number" && Number.isFinite(i.hookTimeoutMs) && i.hookTimeoutMs > 0
        ? i.hookTimeoutMs
        : d.hookTimeoutMs,
    maxTurns:
      typeof i.maxTurns === "number" && Number.isFinite(i.maxTurns) && i.maxTurns > 0
        ? Math.floor(i.maxTurns)
        : d.maxTurns,
  };
}
