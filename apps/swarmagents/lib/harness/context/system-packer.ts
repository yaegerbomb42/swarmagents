/**
 * System-prompt section packer + cache-friendly ordering
 * (lib/harness/context/system-packer.ts).
 *
 * The default ("claude-code") run path appends one system prompt built from
 * named sections — the agent card, the codebase context pack, the role
 * prompt and the account's long-term memory. Until now those sections were
 * joined unbounded: the codebase pack was all-or-nothing at its own 8,000
 * token gate, memory was capped at 1,000, and the agent card / role prompt
 * had no cap at all. This module is the L1-style governor for that join:
 *
 *   - sections are ranked by value density (codebase pack — the code map —
 *     outranks memory, the history-like section);
 *   - the total is hard-capped to a configured estimated-token budget;
 *   - the lowest-value sections are truncated first;
 *   - protected sections (the agent card core and the role instructions —
 *     the run's "system prompt") are NEVER truncated. If the protected
 *     sections alone exceed the budget they are returned intact and the
 *     truncatable sections are dropped: the packer fails open, it never
 *     cuts instructions to fit a number.
 *
 * Cache-friendly ordering emits the most stable sections first (role
 * prompt → agent card → codebase pack → memory) so provider prompt caches
 * can hit on the longest possible stable prefix. The codebase pack changes
 * whenever the repo changes and memory is re-ranked per task, so both ride
 * after the stable head. Ordering changes the prompt the model sees, so it
 * is opt-in (default off); with it off — and packing off — buildArgv never
 * routes through this module and the prompt is byte-identical to before.
 *
 * Pure and dependency-light: token estimates come from lib/codebase/tokens
 * (the same estimator the UI shows) and truncation reuses fitText from the
 * L1 context governor. No env, files or provider config are read here.
 */

import { estimateTokens } from "../../codebase/tokens";
import { fitText } from "./contextGovernor";

/** One named slice of the appended system prompt. */
export interface SystemSection {
  /** Stable id ("agent-card", "role", "codebase", "memory"). */
  id: string;
  text: string;
  /** Value density rank: lower = more valuable, truncated last. */
  priority: number;
  /** Never truncated, whatever the budget (system instructions). */
  protected?: boolean;
  /** Cache-stability rank: lower = more stable, emitted earlier. */
  volatility: number;
}

export interface SectionPackUsage {
  id: string;
  /** Estimated tokens the section occupied before packing. */
  before: number;
  /** Estimated tokens after packing (0 when dropped). */
  used: number;
  truncated: boolean;
}

export interface PackedSystemPrompt {
  /** Sections joined with "\n\n", empty sections omitted. */
  text: string;
  usage: SectionPackUsage[];
  /** Estimated tokens of `text` (separators included). */
  totalTokens: number;
  budgetTokens: number;
  /** Ids of sections that were cut or dropped, in cut order. */
  truncated: string[];
  /** One-line summary for the run telemetry (capability.changed). */
  logLine: string;
}

/** Default estimated-token cap for the appended system prompt when packing. */
export const DEFAULT_SYSTEM_BUDGET_TOKENS = 16_000;

/** Bounds for a user-configured system-prompt budget. */
export const MIN_SYSTEM_BUDGET_TOKENS = 1_000;
export const MAX_SYSTEM_BUDGET_TOKENS = 200_000;

const SEPARATOR = "\n\n";

/**
 * The codebase pack rides at the front of the agent card, wrapped by
 * wrapCodebasePack (lib/codebase/inject.ts) in
 * `<codebase_context ...>...</codebase_context>` markers and joined to the
 * card with one blank line. Split it back out so it can be ranked (and
 * truncated) on its own instead of dragging the whole card with it.
 */
const CODEBASE_PACK_RE = /^<codebase_context[^>]*>[\s\S]*?<\/codebase_context>/;

export function splitCodebasePack(agentCard: string): { pack?: string; card: string } {
  const match = CODEBASE_PACK_RE.exec(agentCard);
  if (!match) return { card: agentCard };
  const rest = agentCard.slice(match[0].length).replace(/^\n\n/, "");
  return { pack: match[0], card: rest };
}

/**
 * Build the ranked sections for one invocation, in today's emission order
 * (codebase pack, agent card, role prompt, memory) so that joining them
 * reproduces the legacy appended prompt byte-for-byte when nothing is cut.
 *
 * Ranks: the agent card and role instructions are the run's system prompt —
 * protected, never cut. The codebase pack (the code map) is the densest
 * truncatable section; memory (relevance-ranked history) is the least.
 * Volatility mirrors how often each section's bytes change between runs.
 */
export function systemSectionsFrom(parts: {
  agentCard?: string;
  rolePrompt?: string;
  memoryContext?: string;
}): SystemSection[] {
  const sections: SystemSection[] = [];
  const agentCard = parts.agentCard ?? "";
  if (agentCard) {
    const { pack, card } = splitCodebasePack(agentCard);
    if (pack) {
      sections.push({ id: "codebase", text: pack, priority: 2, volatility: 2 });
    }
    if (card) {
      sections.push({ id: "agent-card", text: card, priority: 0, protected: true, volatility: 1 });
    }
  }
  if (parts.rolePrompt) {
    sections.push({ id: "role", text: parts.rolePrompt, priority: 1, protected: true, volatility: 0 });
  }
  if (parts.memoryContext) {
    sections.push({ id: "memory", text: parts.memoryContext, priority: 3, volatility: 3 });
  }
  return sections;
}

/** Join sections the way buildArgv always has: blank line between blocks. */
export function joinSystemSections(sections: readonly SystemSection[]): string {
  return sections
    .map((s) => s.text)
    .filter(Boolean)
    .join(SEPARATOR);
}

/**
 * Stable-first emission order for provider prompt caches: role prompt
 * (changes only on role edit), agent card (user edit), codebase pack (repo
 * change), memory (re-ranked per task). Pure reorder — section texts are
 * untouched. Deterministic: equal volatility keeps input order.
 */
export function orderSystemSections(sections: readonly SystemSection[]): SystemSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.volatility - b.section.volatility || a.index - b.index)
    .map(({ section }) => section);
}

/** Clamp a configured budget into the supported range; junk → the default. */
export function resolveSystemBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SYSTEM_BUDGET_TOKENS;
  }
  return Math.min(MAX_SYSTEM_BUDGET_TOKENS, Math.max(MIN_SYSTEM_BUDGET_TOKENS, Math.floor(value)));
}

export function formatSystemPackerLine(packed: Omit<PackedSystemPrompt, "text" | "logLine">): string {
  const parts = packed.usage.map((u) => `${u.id}=${u.used}${u.truncated ? `/${u.before}` : ""}`);
  return (
    `system-packer budget=${packed.budgetTokens} total=${packed.totalTokens}` +
    (parts.length ? ` ${parts.join(" ")}` : "") +
    (packed.truncated.length ? ` truncated=${packed.truncated.join(",")}` : "")
  );
}

/**
 * Pack `sections` into at most `budgetTokens` estimated tokens.
 *
 * Protected sections are kept whole. The remaining budget (minus the
 * separators the join will add) is handed to the truncatable sections in
 * value-density order — densest first — and each is cut with fitText
 * (head-kept: the codebase pack leads with languages/entry points and
 * memory leads with the most relevant facts). Sections that get no budget
 * are dropped. Emission order is the input order; callers that want
 * cache-friendly order pass orderSystemSections(...) in.
 *
 * Never throws on bad input: a non-positive budget falls back to the
 * default, empty sections are ignored.
 */
export function packSystemSections(
  sections: readonly SystemSection[],
  budgetTokens: number = DEFAULT_SYSTEM_BUDGET_TOKENS,
): PackedSystemPrompt {
  const budget = resolveSystemBudget(budgetTokens);
  const present = sections.filter((s) => s.text.length > 0);
  const before = new Map(present.map((s) => [s.id, estimateTokens(s.text)]));
  const separatorCost = estimateTokens(SEPARATOR);

  const protectedTotal = present
    .filter((s) => s.protected)
    .reduce((sum, s) => sum + (before.get(s.id) ?? 0), 0);
  // Charge the separators up front so the joined text stays in budget.
  let remaining = budget - protectedTotal - separatorCost * Math.max(0, present.length - 1);

  const fitted = new Map<string, string>();
  const truncated: string[] = [];
  // Densest first: a higher-value section is filled before a lower one
  // sees a single token of the remaining budget.
  const truncatable = present
    .filter((s) => !s.protected)
    .sort((a, b) => a.priority - b.priority);
  for (const section of truncatable) {
    const size = before.get(section.id) ?? 0;
    if (size <= remaining) {
      fitted.set(section.id, section.text);
      remaining -= size;
    } else if (remaining > 0) {
      const cut = fitText(section.text, remaining, "head");
      fitted.set(section.id, cut);
      remaining -= estimateTokens(cut);
      truncated.push(section.id);
    } else {
      fitted.set(section.id, "");
      truncated.push(section.id);
    }
  }
  for (const section of present) {
    if (section.protected) fitted.set(section.id, section.text);
  }

  const text = joinSystemSections(present.map((s) => ({ ...s, text: fitted.get(s.id) ?? "" })));
  const usage: SectionPackUsage[] = present.map((s) => {
    const usedText = fitted.get(s.id) ?? "";
    return {
      id: s.id,
      before: before.get(s.id) ?? 0,
      used: estimateTokens(usedText),
      truncated: truncated.includes(s.id),
    };
  });
  const packed: PackedSystemPrompt = {
    text,
    usage,
    totalTokens: estimateTokens(text),
    budgetTokens: budget,
    truncated,
    logLine: "",
  };
  packed.logLine = formatSystemPackerLine(packed);
  return packed;
}
