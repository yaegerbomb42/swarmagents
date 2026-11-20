/**
 * Injecting the codebase context pack into a run.
 *
 * The pack is prepended to the run's system prompt so the agent starts with a
 * map of the repository it is working in: languages, entry points, commands,
 * the module layout and the files that everything else depends on.
 *
 * The user can turn the injection off (Settings -> Inject codebase context).
 * When it is on, the pack is injected exactly once per run, and only when it
 * fits inside the token budget.
 */

import { codebaseContextInjectionEnabled, readUserSettings } from "../providers/settings";
import { CONTEXT_PACK_TOKEN_BUDGET } from "./rules";
import {
  ensureCodebaseMap,
  maybeRefreshCodebaseMapOnGitChange,
  selectedCodebaseRepo,
} from "./store";
import type { CodebaseScanner } from "./types";

export interface CodebaseInjectionResult {
  /** False when the account turned the injection off. */
  enabled: boolean;
  /** True when a pack was prepended to the run. */
  injected: boolean;
  repoRoot: string;
  repoHash?: string;
  tokenEstimate?: number;
  text?: string;
  /** Why nothing was injected (for the run log). */
  reason?: string;
}

/**
 * Resolve the pack for a run: honour the toggle, keep the map fresh and
 * return the text to prepend. Never throws.
 *
 * The pack belongs to the repository the account picked (the Codebase tab):
 * an account that never picked one gets no pack, and no map is built behind
 * its back.
 */
export async function resolveCodebaseInjection(
  userId: string,
  scanner: CodebaseScanner,
  fallbackRepoRoot: string,
): Promise<CodebaseInjectionResult> {
  try {
    const settings = readUserSettings(userId);
    if (!codebaseContextInjectionEnabled(settings)) {
      return { enabled: false, injected: false, repoRoot: fallbackRepoRoot, reason: "disabled" };
    }
    const selected = await selectedCodebaseRepo(userId, scanner);
    if (!selected) {
      return { enabled: true, injected: false, repoRoot: fallbackRepoRoot, reason: "no-repo-picked" };
    }
    await maybeRefreshCodebaseMapOnGitChange(userId, scanner, selected).catch(() => undefined);
    const map = await ensureCodebaseMap(userId, scanner, { repoRoot: selected });
    if (!map?.contextPack?.text?.trim()) {
      return { enabled: true, injected: false, repoRoot: selected, reason: "no-map" };
    }
    const pack = map.contextPack;
    if (pack.tokenEstimate > CONTEXT_PACK_TOKEN_BUDGET) {
      return {
        enabled: true,
        injected: false,
        repoRoot: map.repoRoot,
        repoHash: map.repoHash,
        reason: "over-budget",
      };
    }
    return {
      enabled: true,
      injected: true,
      repoRoot: map.repoRoot,
      repoHash: map.repoHash,
      tokenEstimate: pack.tokenEstimate,
      text: pack.text.trim(),
    };
  } catch {
    return { enabled: true, injected: false, repoRoot: fallbackRepoRoot, reason: "error" };
  }
}

/** Wrap the pack in the markers that make it recognisable in a prompt. */
export function wrapCodebasePack(packText: string, meta: { repoHash?: string; repoName?: string } = {}): string {
  const repoHash = meta.repoHash ? ` repo_hash="${meta.repoHash}"` : "";
  const repoName = meta.repoName ? ` repo="${meta.repoName}"` : "";
  return `<codebase_context${repoHash}${repoName}>\n${packText.trim()}\n</codebase_context>`;
}

/** Prepend the pack to an agent card (the system prompt of the run). */
export function prefixAgentCardWithCodebasePack(
  agentCard: string | undefined,
  packText: string,
): string {
  const card = (agentCard ?? "").trim();
  return card ? `${packText.trim()}\n\n${card}` : packText.trim();
}
