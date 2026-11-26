/**
 * Live turn compaction: bound how much tool output a multi-turn run can
 * carry into the model's context.
 *
 * The pieces already existed but were never wired into the live path:
 *
 *   - `filterObservation` (observation-filter.ts) compresses noisy tool
 *     stdout/stderr while preserving failure diagnostics (failing test
 *     names, error codes, file:line references).
 *   - `condenseLog` (log-condenser.ts) does the same for plain logs.
 *   - `ContextGovernor` (contextGovernor.ts) packs one L1 turn from a
 *     fixed 8,192-token budget — but only when the run opts into "l1".
 *
 * The gap: in the default claude-code mode the VM's Claude Code replays
 * its whole session, and every turn it POSTs the full accumulated
 * Anthropic history to /api/runtime/llm/<runToken>/v1/messages, which the
 * gateway forwards as-is. Long desktop/coding runs accumulate oversized
 * tool_result payloads (DOM snapshots, huge logs, thousand-line search
 * dumps) that overflow smaller BYOK/local models — and the runner's own
 * `autoCondenseLogs` switch only filters the harness event stream, never
 * the model-bound history.
 *
 * This module is the shared choke point:
 *
 *   - `compactToolResultText` — one tool result's text, condensed through
 *     the observation filter when it is over the inline threshold.
 *   - `compactAnthropicMessages` — an Anthropic message list with the
 *     tool_result budget enforced: a per-result cap, a total budget
 *     across all results, and a recency window (the newest results keep
 *     their full condensed text and are never summarized away).
 *     Everything else — user text, assistant text, tool_use blocks,
 *     image blocks — passes through untouched.
 *
 * Pure and deterministic: no I/O (the filter runs with spill disabled),
 * the input is never mutated, and histories under the budget come back
 * byte-identical. The gateway applies it in prepareRequest (the shared
 * choke point for streaming and non-streaming forwards); the runner
 * routes its auto-condense path through the same helper.
 */

import { estimateTokens } from "../../codebase/tokens";
import { filterObservation } from "../observation-filter";

/** Total estimated tokens all tool_result content may carry, per request. */
export const DEFAULT_TOOL_RESULT_TOKEN_BUDGET = 32768;
/** One tool_result is condensed when it alone exceeds this many tokens. */
export const DEFAULT_PER_RESULT_TOKEN_CAP = 4096;
/** Newest tool results left untouched even when the budget binds. */
export const DEFAULT_KEEP_RECENT_RESULTS = 2;
/** A single tool result shorter than this passes through unfiltered. */
export const TOOL_RESULT_CHAR_THRESHOLD = 4000;
/** Inline char budget handed to the observation filter per result. */
export const DEFAULT_TOOL_RESULT_INLINE_CHARS = 4000;

export interface CompactToolResultOptions {
  /** Chars below which the text passes through untouched. */
  thresholdChars?: number;
  /** Inline char budget for the filtered text. */
  maxInlineChars?: number;
}

export interface CompactMessagesOptions {
  /** Total token budget for all tool_result content (default 32,768). */
  maxToolResultTokens?: number;
  /** Per-result token cap (default 4,096). */
  perResultTokenCap?: number;
  /** Newest results never compacted (default 2). */
  keepRecentResults?: number;
  /** Inline char budget for each condensed result (default 4,000). */
  maxInlineChars?: number;
  /** Char threshold below which a result passes through (default 4,000). */
  thresholdChars?: number;
}

export interface CompactMessagesStats {
  /** Estimated tool_result tokens before compaction. */
  tokensBefore: number;
  /** Estimated tool_result tokens after compaction. */
  tokensAfter: number;
  /** Tool results seen in the message list. */
  resultsSeen: number;
  /** Tool results whose content was replaced by a condensed version. */
  resultsCompacted: number;
}

export interface CompactMessagesResult {
  messages: unknown[];
  stats: CompactMessagesStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lines that must survive any condensation, even when the format-aware
 * extractors would drop them: exit-code reports ("exit code 1",
 * "exited with code 1"), file:line references, and error lines. The
 * extractors already keep most of these when they sit inside a failure
 * block; this pass is the backstop for the ones that don't (a bare
 * "exit code 1" at the tail of a log, a path in a DOM snapshot).
 * Capped so the backstop itself can never blow the budget.
 */
export const MAX_PRESERVED_SIGNAL_LINES = 20;

const SIGNAL_PATTERNS = [
  /\bexit(?:ed)?(?: with)?(?: code| status)?\s*:?\s*\d+\b/i,
  /\b(?:return|status) code:?\s*\d+\b/i,
  /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|css|html|json|sh|yml|yaml):\d+(?::\d+)?/,
  /error/i,
];

export function extractSignalLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || seen.has(line)) continue;
    if (!SIGNAL_PATTERNS.some((re) => re.test(line))) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_PRESERVED_SIGNAL_LINES) break;
  }
  return out;
}

/**
 * Condense one tool result's text. Short results pass through unchanged;
 * oversized ones run through the observation filter (spill disabled — this
 * must stay pure), which keeps failure lines, file:line references and
 * outcome summaries while dropping noise. Any signal line the filter
 * dropped is re-attached under a `[preserved signals]` note, so file
 * paths, exit codes and error lines provably survive. Never throws: on
 * any unexpected failure the head of the raw text is returned, truncated
 * to the inline budget, so the caller still gets a bounded string.
 */
export function compactToolResultText(text: string, options: CompactToolResultOptions = {}): string {
  const threshold = options.thresholdChars ?? TOOL_RESULT_CHAR_THRESHOLD;
  const maxInlineChars = options.maxInlineChars ?? DEFAULT_TOOL_RESULT_INLINE_CHARS;
  if (text.length <= threshold) return text;
  try {
    const filtered = filterObservation({ output: text, maxInlineChars, allowSpill: false }).text;
    const base = filtered.length > 0 ? filtered : text.slice(0, maxInlineChars);
    const kept = new Set(base.split("\n").map((line) => line.trim()));
    const missing = extractSignalLines(text).filter((line) => !kept.has(line));
    if (missing.length === 0) return base;
    return `${base}\n[preserved signals]\n${missing.join("\n")}`;
  } catch {
    return text.slice(0, maxInlineChars);
  }
}

/** Render one tool_result block's content as plain text (text parts only). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (isRecord(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

/** Replace one tool_result block's content with condensed text, keeping the rest. */
function withCompactedContent(block: Record<string, unknown>, text: string): Record<string, unknown> {
  const content = block.content;
  if (typeof content === "string") return { ...block, content: text };
  if (Array.isArray(content)) {
    // Keep non-text parts (e.g. image blocks) in place; only the text
    // parts are replaced by the single condensed text block.
    const kept = content.filter(
      (item) => !(typeof item === "string" || (isRecord(item) && item.type === "text")),
    );
    return { ...block, content: [{ type: "text", text }, ...kept] };
  }
  return { ...block, content: text };
}

interface ToolResultRef {
  messageIndex: number;
  blockIndex: number;
  block: Record<string, unknown>;
  text: string;
  tokens: number;
}

/**
 * One-line summary of a tool result that has already been condensed as far
 * as the filter can take it: the first non-empty line (the command, the
 * heading, or the first failure line) plus how much was omitted. Used only
 * by the hard-bound step, for the oldest results in very long histories.
 */
export const SUMMARY_FLOOR_TOKENS = 60;

export function summarizeCompactedResult(text: string, tokens: number): string {
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const head = first ? first.slice(0, 160) : "";
  return head
    ? `[tool result compacted: ${head} … (${tokens} tokens omitted)]`
    : `[tool result compacted: ${tokens} tokens omitted]`;
}

/**
 * Enforce the tool_result budget on an Anthropic message list.
 *
 *   1. Any single result over `perResultTokenCap` is condensed through
 *      the observation filter (failure lines, file paths and error lines
 *      survive; noise does not).
 *   2. While the total is over `maxToolResultTokens`, the oldest results
 *      outside the `keepRecentResults` window are condensed one at a time
 *      (oldest first) until the budget holds.
 *   3. Hard bound: if the total is still over budget (very long histories
 *      where every result is already at the filter floor), the oldest
 *      results are replaced by one-line summaries until it holds.
 *
 * Guarantee: `tokensAfter <= maxToolResultTokens` whenever the newest
 * `keepRecentResults` window fits inside it — each window result is
 * capped at `perResultTokenCap` first, so with the defaults
 * (2 x 4,096 < 32,768) the bound always holds. Everything else — user
 * text, assistant text, tool_use blocks, image blocks — passes through
 * untouched.
 *
 * The input list and its messages are never mutated: compacted messages
 * get fresh objects; untouched messages keep their identity. Histories
 * already under budget return the same message references with
 * `resultsCompacted: 0`.
 */
export function compactAnthropicMessages(
  messages: unknown[],
  options: CompactMessagesOptions = {},
): CompactMessagesResult {
  const maxTotal = options.maxToolResultTokens ?? DEFAULT_TOOL_RESULT_TOKEN_BUDGET;
  const perResultCap = options.perResultTokenCap ?? DEFAULT_PER_RESULT_TOKEN_CAP;
  const keepRecent = Math.max(0, options.keepRecentResults ?? DEFAULT_KEEP_RECENT_RESULTS);
  const maxInlineChars = options.maxInlineChars ?? DEFAULT_TOOL_RESULT_INLINE_CHARS;
  const thresholdChars = options.thresholdChars ?? TOOL_RESULT_CHAR_THRESHOLD;

  // Index every tool_result block with its text and token cost.
  const refs: ToolResultRef[] = [];
  messages.forEach((rawMessage, messageIndex) => {
    const message = isRecord(rawMessage) ? rawMessage : null;
    const content = message && Array.isArray(message.content) ? message.content : null;
    if (!content) return;
    content.forEach((rawBlock, blockIndex) => {
      const block = isRecord(rawBlock) ? rawBlock : null;
      if (!block || block.type !== "tool_result") return;
      const text = toolResultText(block.content);
      refs.push({ messageIndex, blockIndex, block, text, tokens: estimateTokens(text) });
    });
  });

  const tokensBefore = refs.reduce((sum, ref) => sum + ref.tokens, 0);
  const stats: CompactMessagesStats = {
    tokensBefore,
    tokensAfter: tokensBefore,
    resultsSeen: refs.length,
    resultsCompacted: 0,
  };
  if (refs.length === 0) return { messages, stats };

  // Compacted text per (message, block), filled in below.
  const compacted = new Map<string, string>();
  const key = (ref: ToolResultRef): string => `${ref.messageIndex}:${ref.blockIndex}`;
  const currentText = (ref: ToolResultRef): string => compacted.get(key(ref)) ?? ref.text;
  const currentTokens = (ref: ToolResultRef): number => estimateTokens(currentText(ref));
  /** Replace a result's text; returns the tokens saved (0 when unchanged). */
  const replace = (ref: ToolResultRef, text: string): number => {
    if (text === currentText(ref)) return 0;
    const saved = currentTokens(ref) - estimateTokens(text);
    if (!compacted.has(key(ref))) stats.resultsCompacted += 1;
    compacted.set(key(ref), text);
    return saved;
  };

  // Step 1: per-result cap, oldest first (deterministic order).
  let total = tokensBefore;
  for (const ref of refs) {
    if (ref.tokens > perResultCap) {
      total -= replace(ref, compactToolResultText(ref.text, { thresholdChars, maxInlineChars }));
    }
  }

  // Step 2: total budget, oldest first, never touching the newest window.
  const compactable = refs.slice(0, Math.max(0, refs.length - keepRecent));
  for (const ref of compactable) {
    if (total <= maxTotal) break;
    total -= replace(ref, compactToolResultText(ref.text, { thresholdChars, maxInlineChars }));
  }

  // Step 3: hard bound — summarize the oldest results until it holds.
  for (const ref of compactable) {
    if (total <= maxTotal) break;
    if (currentTokens(ref) <= SUMMARY_FLOOR_TOKENS) continue;
    total -= replace(ref, summarizeCompactedResult(ref.text, ref.tokens));
  }
  stats.tokensAfter = total;

  if (compacted.size === 0) return { messages, stats };

  const out = messages.map((rawMessage, messageIndex) => {
    const message = isRecord(rawMessage) ? rawMessage : null;
    const content = message && Array.isArray(message.content) ? message.content : null;
    if (!content) return rawMessage;
    let changed = false;
    const nextContent = content.map((rawBlock, blockIndex) => {
      const replacement = compacted.get(`${messageIndex}:${blockIndex}`);
      if (replacement === undefined) return rawBlock;
      const block = isRecord(rawBlock) ? rawBlock : null;
      if (!block) return rawBlock;
      changed = true;
      return withCompactedContent(block, replacement);
    });
    if (!changed) return rawMessage;
    return { ...message, content: nextContent };
  });
  return { messages: out, stats };
}
