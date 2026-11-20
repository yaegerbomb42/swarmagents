/**
 * Model families: which lab a model id comes from, independent of the host
 * that serves it. "anthropic/claude-sonnet-4.5" on OpenRouter and
 * "claude-sonnet-4-5" on Anthropic are both the claude family; "gpt-4.1" on
 * Azure and on OpenAI are both gpt.
 *
 * Used by the run pool to switch a running task to a different family
 * (e.g. Claude → GPT) and to keep failover inside a family when asked.
 * Pure string matching — no network, no keys.
 */

export const MODEL_FAMILIES = [
  "claude",
  "gpt",
  "gemini",
  "gemma",
  "llama",
  "qwen",
  "deepseek",
  "mistral",
  "grok",
  "kimi",
  "glm",
  "minimax",
  "command",
  "nemotron",
  "phi",
  "mercury",
] as const;

export type KnownModelFamily = (typeof MODEL_FAMILIES)[number];
/** A known family, or "other" when the id matches none of them. */
export type ModelFamily = KnownModelFamily | "other";

/**
 * Ordered: the first match wins, so more specific names come first
 * (e.g. "nemotron" before "llama" for "llama-3.1-nemotron-70b", "gemma"
 * before "gemini", "deepseek" before "qwen" for "deepseek-r1-distill-qwen").
 */
const RULES: ReadonlyArray<readonly [KnownModelFamily, RegExp]> = [
  ["claude", /claude|(?:^|[^a-z])(?:opus|sonnet|haiku)(?:[^a-z]|$)/],
  ["nemotron", /nemotron/],
  ["deepseek", /deepseek/],
  ["gemma", /gemma/],
  ["gemini", /gemini/],
  ["gpt", /(?:^|[^a-z])(?:gpt|chatgpt|codex)(?:[^a-z]|$)|(?:^|\/)o[1-9](?:-|$)/],
  ["llama", /llama/],
  ["qwen", /qwen|qwq/],
  ["mistral", /mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/],
  ["grok", /grok/],
  ["kimi", /kimi|moonshot/],
  ["glm", /glm/],
  ["minimax", /minimax|abab/],
  ["command", /(?:^|[^a-z])command(?:[^a-z]|$)|(?:^|[^a-z])aya(?:[^a-z]|$)/],
  ["phi", /(?:^|[^a-z])phi-?\d/],
  ["mercury", /mercury/],
];

/** The family a model id belongs to ("other" when unknown). */
export function modelFamily(model: string | undefined | null): ModelFamily {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id) return "other";
  for (const [family, pattern] of RULES) {
    if (pattern.test(id)) return family;
  }
  return "other";
}

export function isModelFamily(value: unknown): value is KnownModelFamily {
  return typeof value === "string" && (MODEL_FAMILIES as readonly string[]).includes(value);
}
