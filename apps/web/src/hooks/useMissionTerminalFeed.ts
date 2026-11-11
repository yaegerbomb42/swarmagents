'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalLine } from '@/components/ConsoleTerminal';
import type { AgentSandbox, SandboxAction, TelemetryEvent } from '@/lib/sandboxTypes';

function lineId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function actionToLine(agentId: string, action: SandboxAction): TerminalLine {
  const kind =
    action.status === 'error' ? 'error' : action.type === 'think' ? 'system' : 'output';
  const detail =
    action.diffLines?.split('\n').slice(0, 2).join('\n') ||
    action.params?.map((p) => `${p.key}=${p.value}`).join(' ') ||
    '';
  const text = detail
    ? `[${agentId}] ${action.label} — ${detail}`
    : `[${agentId}] ${action.label}`;
  return { id: lineId('act'), kind, text };
}

export function useMissionTerminalFeed(sessionId: string | null, projectId?: string | null) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [connected, setConnected] = useState(false);
  const seenEvents = useRef(new Set<string>());

  const append = useCallback((kind: TerminalLine['kind'], text: string) => {
    if (!text.trim()) return;
    setLines((prev) => [...prev, { id: lineId('mission'), kind, text }].slice(-500));
  }, []);

  useEffect(() => {
    if (!sessionId && !projectId) return;
    const streamId = projectId || sessionId || 'default';
    let disposed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      eventSource = new EventSource(`/api/telemetry?projectId=${encodeURIComponent(streamId)}`);
      eventSource.onopen = () => {
        setConnected(true);
        attempt = 0;
      };
      eventSource.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data) as TelemetryEvent;
          const key = `${payload.ts}:${payload.agentId}:${payload.type}`;
          if (seenEvents.current.has(key)) return;
          seenEvents.current.add(key);
          if (seenEvents.current.size > 2000) {
            seenEvents.current = new Set([...seenEvents.current].slice(-500));
          }

          if (payload.type === 'failover') {
            const p = payload.payload as Record<string, unknown>;
            const provider = String(p.provider ?? 'provider');
            const reason = String(p.reason ?? p.status_code ?? 'failover');
            setLines((prev) =>
              [
                ...prev,
                {
                  id: lineId('failover'),
                  kind: 'system' as const,
                  text: `⚡ failover: ${provider} → ${reason}`,
                },
              ].slice(-500),
            );
            return;
          }

          if (payload.type === 'action_log') {
            const action = payload.payload as SandboxAction;
            if (action?.label) {
              setLines((prev) => [...prev, actionToLine(payload.agentId, action)].slice(-500));
            }
            return;
          }

          if (payload.type === 'agent_update') {
            const sandbox = payload.payload as Partial<AgentSandbox>;
            const last = sandbox.logs?.[sandbox.logs.length - 1];
            if (last?.text) {
              const kind: TerminalLine['kind'] =
                last.kind === 'stderr' || last.kind === 'error' ? 'error' : 'output';
              setLines((prev) =>
                [...prev, { id: lineId('log'), kind, text: `[${payload.agentId}] ${last.text}` }].slice(
                  -500,
                ),
              );
            }
          }
        } catch {
          /* ignore malformed SSE */
        }
      };
      eventSource.addEventListener('heartbeat', () => setConnected(true));
      eventSource.onerror = () => {
        setConnected(false);
        eventSource?.close();
        eventSource = null;
        if (disposed) return;
        const delay = Math.min(200, 50 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      eventSource?.close();
    };
  }, [sessionId, projectId]);

  return { lines, append, connected };
}
