'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type DiffStreamState = {
  diffText: string;
  filename: string;
  streaming: boolean;
  done: boolean;
  error: string | null;
};

export function useDiffStream(
  sessionId: string | null | undefined,
  options?: { filename?: string; enabled?: boolean },
): DiffStreamState {
  const filename = options?.filename ?? 'index.html';
  const enabled = options?.enabled !== false && Boolean(sessionId);
  const [diffText, setDiffText] = useState('');
  const [streamFilename, setStreamFilename] = useState(filename);
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    setDiffText('');
    setDone(false);
    setError(null);
    setStreaming(true);
    setStreamFilename(filename);

    const url = `/api/console/diff?sessionId=${encodeURIComponent(sessionId)}&filename=${encodeURIComponent(filename)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type: string;
          text?: string;
          filename?: string;
        };
        if (data.type === 'chunk' && data.text) {
          setDiffText((prev) => prev + data.text);
        } else if (data.type === 'meta' && data.filename) {
          setStreamFilename(data.filename);
        } else if (data.type === 'done') {
          setStreaming(false);
          setDone(true);
          es.close();
        }
      } catch {
        setError('malformed diff stream');
      }
    };

    es.onerror = () => {
      setStreaming(false);
      setError('diff stream disconnected');
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [enabled, sessionId, filename]);

  return { diffText, filename: streamFilename, streaming, done, error };
}

export async function submitPatchDecision(opts: {
  action: 'approve' | 'reject';
  sessionId: string;
  filename: string;
  patch: string;
}): Promise<{ ok: boolean; status: string }> {
  const res = await fetch('/api/console/diff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = (await res.json()) as { ok?: boolean; status?: string; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(data.error ?? `patch ${opts.action} failed`);
  }
  return { ok: true, status: data.status ?? opts.action };
}

export function usePatchActions(sessionId: string | null | undefined, filename: string, patch: string) {
  const [status, setStatus] = useState<'idle' | 'approved' | 'rejected' | 'error'>('idle');

  const approve = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await submitPatchDecision({
        action: 'approve',
        sessionId,
        filename,
        patch,
      });
      setStatus(result.status === 'approved' ? 'approved' : 'idle');
    } catch {
      setStatus('error');
    }
  }, [sessionId, filename, patch]);

  const reject = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await submitPatchDecision({
        action: 'reject',
        sessionId,
        filename,
        patch,
      });
      setStatus(result.status === 'rejected' ? 'rejected' : 'idle');
    } catch {
      setStatus('error');
    }
  }, [sessionId, filename, patch]);

  return { status, approve, reject };
}
