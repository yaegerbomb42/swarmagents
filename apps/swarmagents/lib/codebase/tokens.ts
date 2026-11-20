/**
 * Token budgeting for the context pack.
 *
 * The pack is prepended to every run's system prompt, so its size has to be
 * bounded *and* predictable: the same estimate is shown in the UI and used to
 * decide whether the pack still fits. The estimate is deliberately a little
 * conservative (code packs more tokens per character than prose).
 */

/** Rough tokens per character for source code and short English sentences. */
const CHARS_PER_TOKEN = 3.6;

/** Extra tokens charged per whitespace-separated word. */
const TOKENS_PER_WORD = 1 / 12;

/** Rough token estimate for a piece of text. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN + words * TOKENS_PER_WORD));
}

/** Marker appended to a pack that had to be cut short. */
export const TRUNCATION_MARKER = "\n…[codebase context truncated to fit budget]";

/**
 * Cut `text` down to `budget` estimated tokens. The result always fits the
 * budget (the marker included) and never ends mid-word when a line break is
 * close enough to cut on.
 */
export function truncateToTokenBudget(
  text: string,
  budget: number,
): { text: string; tokenEstimate: number; truncated: boolean } {
  const est = estimateTokens(text);
  if (est <= budget) return { text, tokenEstimate: est, truncated: false };

  // Largest prefix (plus the marker) whose estimate still fits the budget.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid) + TRUNCATION_MARKER) <= budget) lo = mid;
    else hi = mid - 1;
  }

  let out = text.slice(0, lo);
  const cut = out.lastIndexOf("\n");
  if (cut > lo * 0.6) out = out.slice(0, cut);
  out += TRUNCATION_MARKER;
  return { text: out, tokenEstimate: estimateTokens(out), truncated: true };
}
