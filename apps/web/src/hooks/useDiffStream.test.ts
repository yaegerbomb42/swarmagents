import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDiffStream, submitPatchDecision } from './useDiffStream';

describe('useDiffStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('accumulates SSE chunks', async () => {
    class MockES {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: 'chunk', text: '+line\n' }),
          } as MessageEvent);
          this.onmessage?.({
            data: JSON.stringify({ type: 'done', filename: 'a.ts' }),
          } as MessageEvent);
        }, 10);
      }
    }
    vi.stubGlobal('EventSource', MockES);

    const { result } = renderHook(() => useDiffStream('sess-1', { filename: 'a.ts' }));

    await waitFor(() => {
      expect(result.current.diffText).toContain('+line');
      expect(result.current.done).toBe(true);
    });
  });
});

describe('submitPatchDecision', () => {
  it('posts approve action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, status: 'approved' }),
      }),
    );
    const result = await submitPatchDecision({
      action: 'approve',
      sessionId: 's',
      filename: 'f.ts',
      patch: 'p',
    });
    expect(result.status).toBe('approved');
  });
});
