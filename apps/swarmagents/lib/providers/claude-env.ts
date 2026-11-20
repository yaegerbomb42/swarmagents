/**
 * Claude Code environment selection for the multi-provider router.
 *
 * The Claude CLI inside a user's VM is pointed at one provider pool entry
 * (gateway + key + model) purely through environment variables — never argv.
 * This module builds that env from a provider selection and knows how to read
 * a failed run's error message to decide whether failover to the next provider
 * is worthwhile (401 / 429 / overloaded).
 */

import { DEFAULT_BASE_URLS } from "./adapters";
import type { ProviderErrorKind, ProviderKind } from "./types";

/** Input for buildClaudeEnv: one ranked provider, one key slot, one model. */
export interface ClaudeSelectionInput {
  /** Stable, non-secret provider id (e.g. "mercury", "anthropic"). */
  provider: string;
  kind: ProviderKind;
  /** Gateway root. Omit to use the provider kind's public host. */
  baseUrl?: string;
  /** Raw credential for the selected key slot. Only ever copied into env. */
  key: string;
  model: string;
}

/**
 * Build the env map handed to Claude Code for one provider/key/model.
 *
 * Gateways (Anthropic-compatible proxies such as Mercury/Radium/LiteLLM) get
 * ANTHROPIC_AUTH_TOKEN — the CLI then authenticates with
 * `Authorization: Bearer <token>`. The native Anthropic host gets
 * ANTHROPIC_API_KEY, which the CLI sends as `x-api-key`; sending a Bearer
 * token there would be rejected.
 */
export function buildClaudeEnv(selection: ClaudeSelectionInput): Record<string, string> {
  const baseUrl = selection.baseUrl ?? DEFAULT_BASE_URLS[selection.kind];
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: selection.model,
  };
  if (selection.kind === "anthropic" && baseUrl === DEFAULT_BASE_URLS.anthropic) {
    env.ANTHROPIC_API_KEY = selection.key;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = selection.key;
  }
  return env;
}

/**
 * A lease on one provider pool entry, handed out by Router#selectForClaude.
 * The raw key never leaves lib/providers: callers get the built env plus the
 * safe key slot label, and report the run's outcome through settle() so the
 * pool's cooldown/rotation state stays accurate.
 */
export interface ClaudeSelection {
  /** Claude Code env: ANTHROPIC_BASE_URL / *_AUTH_TOKEN | *_API_KEY / *_MODEL. */
  env: Record<string, string>;
  /** Every raw key across all configured pools, for the harness redactor. */
  secrets: string[];
  provider: string;
  /** Safe key slot label (e.g. "mercury:key-1"), never the key itself. */
  keyId: string;
  model: string;
  /**
   * Report how the run using this selection ended. `ok:false` records a
   * failure (with kind/status) so the pool applies cooldown and rotation.
   */
  settle(outcome: { ok: boolean; kind?: ProviderErrorKind; status?: number; retryAfterMs?: number }): void;
  /** Release the lease without recording success or failure (e.g. abort). */
  release(): void;
}

/** Statuses that mean "skip this provider/key and try the next one". */
const FAILOVER_STATUSES = new Set([401, 429, 529]);

/**
 * Classify a Claude Code run error message. Returns the provider error kind
 * and HTTP status when the failure is failover-eligible (401 auth, 429 rate
 * limit, 529/`overloaded` server overload), otherwise null.
 */
export function classifyClaudeRunError(message: string): { kind: ProviderErrorKind; status?: number } | null {
  const text = String(message);
  let status: number | undefined;
  let kind: ProviderErrorKind | undefined;

  const statusMatch = text.match(/(?:^|\D)(\d{3})(?:\D|$)/);
  if (statusMatch) {
    status = Number(statusMatch[1]);
    if (FAILOVER_STATUSES.has(status)) {
      kind = status === 429 ? "rate_limit" : status === 401 ? "auth" : "server";
    }
  }
  // Anthropic gateways report overload as 529 or with "overloaded" in the body.
  if (kind === undefined && /overload/i.test(text)) {
    kind = "server";
  }

  return kind !== undefined ? { kind, status } : null;
}

/** True when a run error means the next provider should be tried. */
export function isClaudeFailoverEligible(message: string): boolean {
  return classifyClaudeRunError(message) !== null;
}
