'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamRun } from '@/lib/team/types';

/**
 * Live view of one team run.
 *
 * The route replays a full snapshot first, then pushes the whole run on every
 * telemetry event, so the panel never has to merge deltas. Connection loss is
 * surfaced instead of faked: the last known snapshot stays visible with a
 * `reconnecting` flag.
 */
export function useTeamRun(runId: string | null): {
  run: TeamRun | null;
  error: string | null;
  connected: boolean;
  refresh: () => void;
} {
  const [run, setRun] = useState<TeamRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setError(null);
      setConnected(false);
      return;
    }

    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    let closed = false;

    const open = async () => {
      try {
        const res = await fetch(`/api/team/${encodeURIComponent(runId)}`, {
          signal: ctrl.signal,
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) {
          setError(res.status === 404 ? 'This team run is gone.' : `Team stream ${res.status}`);
          setConnected(false);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            try {
              const msg = JSON.parse(line.slice(5).trim()) as { op: string; run?: TeamRun };
              if (msg.run) {
                setRun(msg.run);
                setError(null);
                setConnected(true);
              }
            } catch {
              /* keep-alive or partial frame */
            }
          }
        }
        if (!closed) setConnected(false);
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : 'team stream failed');
          setConnected(false);
        }
      }
    };

    void open();
    return () => {
      closed = true;
      ctrl.abort();
    };
  }, [runId, nonce]);

  return { run, error, connected, refresh };
}