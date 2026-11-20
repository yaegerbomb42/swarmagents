import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  GEMINI_CACHED_CONTENT_THRESHOLD_TOKENS,
  injectPromptCaching,
} from '../../../src/providers/cache-headers.js';
import type { CacheableMessage } from '../../../src/providers/cache-headers.js';

const ephemeral = { type: 'ephemeral' as const };

/** Count blocks annotated with `cache_control` across all messages. */
function breakpointCount(messages: readonly CacheableMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === 'object' && 'cache_control' in block) count += 1;
      }
    }
  }
  return count;
}

describe('injectPromptCaching / anthropic', () => {
  it('annotates the last system block, the goal message, and the 2nd-to-last turn', () => {
    const messages: CacheableMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'You are omnexx.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Goal: ship the feature.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Status?' }] },
    ];

    const result = injectPromptCaching(messages, 'anthropic');

    // Last system block (index 0).
    expect(result[0]?.content).toEqual([
      { type: 'text', text: 'You are omnexx.', cache_control: ephemeral },
    ]);
    // First user / goal message (index 1).
    expect(result[1]?.content).toEqual([
      { type: 'text', text: 'Goal: ship the feature.', cache_control: ephemeral },
    ]);
    // 2nd-to-last turn (index 2).
    expect(result[2]?.content).toEqual([
      { type: 'text', text: 'On it.', cache_control: ephemeral },
    ]);
    // Freshest message stays unannotated.
    expect(result[3]?.content).toEqual([{ type: 'text', text: 'Status?' }]);

    expect(breakpointCount(result)).toBeLessThanOrEqual(ANTHROPIC_MAX_BREAKPOINTS);
    expect(breakpointCount(result)).toBe(3);
  });

  it('never mutates the input and only clones what changes', () => {
    const messages: CacheableMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'You are omnexx.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Goal: ship the feature.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Status?' }] },
    ];
    const snapshot = JSON.stringify(messages);

    const result = injectPromptCaching(messages, 'anthropic');

    expect(result).not.toBe(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
    // The untouched message is returned by reference (no cloning of what does not change).
    expect(result[3]).toBe(messages[3]);
  });

  it('keeps going without a system message (goal + rolling checkpoint only)', () => {
    const messages: CacheableMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Goal: build it.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Planning…' }] },
      { role: 'user', content: [{ type: 'text', text: 'Go ahead.' }] },
    ];

    const result = injectPromptCaching(messages, 'anthropic');

    expect(result[0]?.content).toEqual([
      { type: 'text', text: 'Goal: build it.', cache_control: ephemeral },
    ]);
    expect(result[1]?.content).toEqual([
      { type: 'text', text: 'Planning…', cache_control: ephemeral },
    ]);
    expect(result[2]?.content).toEqual([{ type: 'text', text: 'Go ahead.' }]);
  });

  it('normalizes string content to a text block when the message is annotated', () => {
    const messages: CacheableMessage[] = [
      { role: 'system', content: 'You are omnexx.' },
      { role: 'user', content: 'Goal here.' },
      { role: 'assistant', content: 'ok' },
    ];

    const result = injectPromptCaching(messages, 'anthropic');

    expect(result[0]?.content).toEqual([
      { type: 'text', text: 'You are omnexx.', cache_control: ephemeral },
    ]);
    // Goal message is also the 2nd-to-last turn here; duplicate target is deduped.
    expect(result[1]?.content).toEqual([
      { type: 'text', text: 'Goal here.', cache_control: ephemeral },
    ]);
    // Untouched message keeps its string content.
    expect(result[2]?.content).toBe('ok');
  });

  it('skips a turn whose last block cannot carry a breakpoint (thinking)', () => {
    const messages: CacheableMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Goal.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'thinking', text: '…' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Question?' }] },
    ];

    const result = injectPromptCaching(messages, 'anthropic');

    expect(result[0]?.content).toEqual([{ type: 'text', text: 'Goal.', cache_control: ephemeral }]);
    // 2nd-to-last turn (index 1) ends in thinking: left untouched.
    expect(result[1]).toBe(messages[1]);
    expect(result[2]).toBe(messages[2]);
  });

  it('is a no-op for an empty conversation', () => {
    expect(injectPromptCaching([], 'anthropic')).toEqual([]);
  });

  it('annotates the only message in a single-turn conversation (the goal)', () => {
    const single: CacheableMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const result = injectPromptCaching(single, 'anthropic');

    expect(result).not.toBe(single);
    expect(result[0]?.content).toEqual([{ type: 'text', text: 'hi', cache_control: ephemeral }]);
  });
});

describe('injectPromptCaching / gemini', () => {
  it('returns the messages unchanged below the cachedContent threshold', () => {
    const messages: CacheableMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Short prompt.' }] },
    ];

    const result = injectPromptCaching(messages, 'gemini');

    expect(result.cachedContent).toBeUndefined();
    expect(result).not.toBe(messages);
    expect(result[0]).toBe(messages[0]);
  });

  it('marks the array with cachedContent when the conversation crosses 32,768 tokens', () => {
    const text = 'x'.repeat(GEMINI_CACHED_CONTENT_THRESHOLD_TOKENS * 3 + 3);
    const messages: CacheableMessage[] = [{ role: 'user', content: [{ type: 'text', text }] }];

    const result = injectPromptCaching(messages, 'gemini');

    expect(result.cachedContent).toBe(true);
    expect(result).not.toBe(messages);
    expect(result[0]).toBe(messages[0]);
  });

  it('does not flag a conversation at exactly the threshold (strictly greater)', () => {
    const text = 'x'.repeat(GEMINI_CACHED_CONTENT_THRESHOLD_TOKENS * 3);
    const messages: CacheableMessage[] = [{ role: 'user', content: [{ type: 'text', text }] }];

    const result = injectPromptCaching(messages, 'gemini');

    expect(result.cachedContent).toBeUndefined();
  });
});

describe('injectPromptCaching / openai', () => {
  it('returns the messages unmodified (same reference)', () => {
    const messages: CacheableMessage[] = [
      { role: 'system', content: 'You are omnexx.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
    ];

    const result = injectPromptCaching(messages, 'openai');

    expect(result).toBe(messages);
    expect(result.cachedContent).toBeUndefined();
  });
});
