/**
 * System-1 settings. Everything is OFF unless a user/run setting turns it
 * on: `enabled` is the master switch and each gate has its own flag.
 * Thresholds default to Omnexx's shipped values
 * (vendor/omnexx/src/config/sections/system-one.ts).
 */

export interface SystemOneSettings {
  /** Master switch. False → every hook is a no-op pass-through. */
  enabled: boolean;
  /** P(destructive) above which a Bash command is escalated to an approval. */
  destructiveThreshold: number;
  /** P(done) above which a re-inspecting loop is stopped early. */
  earlyStopThreshold: number;
  /** Intent confidence above which a read-only prefetch is attached to the prompt. */
  speculativeThreshold: number;
  /** P(lazy placeholder) above which an edit is refused before it is written. */
  patchPlaceholderThreshold: number;
  /** Per-hook budget; a slower scorer is treated as an error (fail-open). */
  hookTimeoutMs: number;
  gates: {
    guardrail: boolean;
    earlyStop: boolean;
    outputTriage: boolean;
    speculativeRouting: boolean;
    patchSanity: boolean;
  };
}

export const DEFAULT_SYSTEM_ONE_SETTINGS: Readonly<SystemOneSettings> = Object.freeze({
  enabled: false,
  destructiveThreshold: 0.85,
  earlyStopThreshold: 0.9,
  speculativeThreshold: 0.8,
  patchPlaceholderThreshold: 0.85,
  hookTimeoutMs: 1500,
  gates: Object.freeze({
    guardrail: true,
    earlyStop: true,
    outputTriage: true,
    speculativeRouting: true,
    patchSanity: true,
  }),
});

export type SystemOneSettingsInput = Partial<Omit<SystemOneSettings, "gates">> & {
  gates?: Partial<SystemOneSettings["gates"]>;
};

const unit = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;

/**
 * Merge user/run settings over the defaults. Invalid values (out-of-range
 * thresholds, non-booleans) fall back to the default instead of throwing:
 * a bad setting must never block a run.
 */
export function resolveSystemOneSettings(input: SystemOneSettingsInput | null | undefined = {}): SystemOneSettings {
  const d = DEFAULT_SYSTEM_ONE_SETTINGS;
  const i = input ?? {};
  const g = i.gates ?? {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  return {
    enabled: flag(i.enabled, d.enabled),
    destructiveThreshold: unit(i.destructiveThreshold, d.destructiveThreshold),
    earlyStopThreshold: unit(i.earlyStopThreshold, d.earlyStopThreshold),
    speculativeThreshold: unit(i.speculativeThreshold, d.speculativeThreshold),
    patchPlaceholderThreshold: unit(i.patchPlaceholderThreshold, d.patchPlaceholderThreshold),
    hookTimeoutMs:
      typeof i.hookTimeoutMs === "number" && Number.isFinite(i.hookTimeoutMs) && i.hookTimeoutMs > 0
        ? i.hookTimeoutMs
        : d.hookTimeoutMs,
    gates: {
      guardrail: flag(g.guardrail, d.gates.guardrail),
      earlyStop: flag(g.earlyStop, d.gates.earlyStop),
      outputTriage: flag(g.outputTriage, d.gates.outputTriage),
      speculativeRouting: flag(g.speculativeRouting, d.gates.speculativeRouting),
      patchSanity: flag(g.patchSanity, d.gates.patchSanity),
    },
  };
}
