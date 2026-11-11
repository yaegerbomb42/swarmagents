/**
 * Provider prompt-caching header adapter.
 *
 * Injects the cache breakpoint metadata each provider needs right before a request goes on
 * the wire, given the same conversation `messages` array. The array is treated as immutable:
 * a new array (with new copies only of the messages/blocks that change) is returned, never a
 * mutation of the input.
 *
 * - Anthropic caches on explicit `cache_control` breakpoints. We attach one to the last
 *   system block, the first user message (the one that defines the primary goal), and the
 *   2nd-to-last turn (a rolling checkpoint so each turn reads the previous one from cache),
 *   capped at Anthropic's limit of 4 annotated blocks.
 * - Gemini caches a whole conversation as a named `cachedContent` resource once it is large
 *   enough. When the conversation crosses that size we mark it on the returned array (the
 *   `cachedContent` flag) so the caller attaches the request-level parameter; the messages
 *   themselves are not rewritten.
 * - OpenAI auto-caches prefixes of 1024+ tokens, so the messages are returned unmodified.
 */

export type InjectProvider = 'anthropic' | 'gemini' | 'openai';

/** A content block in a provider-neutral message. Shape is per provider (Anthropic/SDK-ish). */
export interface CacheableBlock {
  type?: string;
  text?: string;
  /** Anthropic cache breakpoint. */
  cache_control?: { type: 'ephemeral' };
  [key: string]: unknown;
}

export interface CacheableMessage {
  role: 'system' | 'user' | 'assistant';
  content?: string | readonly CacheableBlock[];
}

/** Messages plus the optional Gemini `cachedContent` marker. */
export type CachedMessages = CacheableMessage[] & { cachedContent?: boolean };

/** Anthropic's limit on annotated blocks per request. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4;

/** Gemini only caches conversations past this many tokens. */
export const GEMINI_CACHED_CONTENT_THRESHOLD_TOKENS = 32_768;

/**
 * Rough token estimate, matching the harness's default estimator elsewhere (≈3 chars/token).
 * Good enough to decide whether a Gemini conversation is past the caching threshold.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function blockTokens(block: CacheableBlock): number {
  return typeof block.text === 'string'
    ? estimateTokens(block.text)
    : estimateTokens(JSON.stringify(block));
}

function messageTokens(message: CacheableMessage): number {
  if (typeof message.content === 'string') return estimateTokens(message.content);
  const blocks: readonly CacheableBlock[] = message.content ?? [];
  return blocks.reduce((total, block) => total + blockTokens(block), 0);
}

function tokensOf(messages: readonly CacheableMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

/** Blocks that cannot carry a cache breakpoint (they are model output sent back verbatim). */
function isThinkingish(block: CacheableBlock): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking';
}

/** Index of the last block that may carry a breakpoint, or -1 when none can. */
function lastBreakableBlockIndex(blocks: readonly CacheableBlock[]): number {
  const last = blocks.length - 1;
  if (last < 0) return -1;
  const block = blocks[last];
  return block && !isThinkingish(block) ? last : -1;
}

/** Normalize a message's content into a block array (string content becomes one text block). */
function toBlocks(content: CacheableMessage['content']): CacheableBlock[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [...content];
}

/**
 * Inject Anthropic `cache_control` breakpoints:
 * - the last system block (the stable prefix),
 * - the first user message (the primary goal),
 * - the 2nd-to-last turn (rolling checkpoint),
 * deduped and capped at {@link ANTHROPIC_MAX_BREAKPOINTS}.
 */
function injectAnthropic(messages: readonly CacheableMessage[]): CacheableMessage[] {
  const priorities: number[] = [];

  let systemLast = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === 'system') systemLast = i;
  }
  if (systemLast >= 0) priorities.push(systemLast);

  const goal = messages.findIndex((message) => message.role === 'user');
  if (goal >= 0 && !priorities.includes(goal)) priorities.push(goal);

  const rolling = messages.length - 2;
  if (rolling >= 0) {
    const message = messages[rolling];
    if (message !== undefined && message.role !== 'system' && !priorities.includes(rolling)) {
      priorities.push(rolling);
    }
  }

  const targets = new Set(priorities.slice(0, ANTHROPIC_MAX_BREAKPOINTS));

  return messages.map((message, index) => {
    if (!targets.has(index)) return message;
    const blocks = toBlocks(message.content);
    const breakIndex = lastBreakableBlockIndex(blocks);
    if (breakIndex < 0) return message;
    const content = blocks.map((block, i) =>
      i === breakIndex ? { ...block, cache_control: { type: 'ephemeral' as const } } : block,
    );
    return { ...message, content };
  });
}

/** Mark the returned array when a Gemini conversation crosses the cachedContent threshold. */
function injectGemini(messages: readonly CacheableMessage[]): CachedMessages {
  const overThreshold = tokensOf(messages) > GEMINI_CACHED_CONTENT_THRESHOLD_TOKENS;
  if (!overThreshold) return [...messages];
  const out: CachedMessages = [...messages];
  out.cachedContent = true;
  return out;
}

/**
 * Attach the provider's prompt-caching metadata to a conversation's messages.
 *
 * Returns a new array; the input is never mutated. For `openai` the messages are returned
 * unmodified (OpenAI auto-caches prefixes of 1024+ tokens).
 */
export function injectPromptCaching(
  messages: CacheableMessage[],
  provider: InjectProvider,
): CachedMessages {
  if (provider === 'anthropic') return injectAnthropic(messages);
  if (provider === 'gemini') return injectGemini(messages);
  return messages;
}
