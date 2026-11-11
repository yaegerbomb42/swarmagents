import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeUserInput } from '@/lib/decompEngine';

vi.mock('@/lib/learning-engine', () => ({
  getLearningEngine: () => ({
    retrieveContext: vi.fn(async (prompt: string) => ({ augmentedPrompt: prompt })),
    logConversation: vi.fn(async () => {}),
  }),
}));

vi.mock('@/lib/engineClient', () => ({
  engineChat: vi.fn(async () => ({
    ok: true,
    content: 'ok',
    model_used: 'test-model',
  })),
  flattenMessages: vi.fn((msgs: { role: string; content: string }[]) =>
    msgs.map((m) => m.content).join('\n'),
  ),
}));

describe('conductor POST input sanitization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('strips control characters from user messages', async () => {
    const raw = 'hello\u0000world';
    const sanitized = sanitizeUserInput(raw);
    expect(sanitized).toBe('helloworld');
    expect(sanitized).not.toContain('\u0000');
  });

  it('clamps oversized message content', () => {
    const long = 'x'.repeat(5000);
    expect(sanitizeUserInput(long).length).toBe(2000);
  });
});
