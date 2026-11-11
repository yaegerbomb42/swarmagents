'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentSandbox, TelemetryEvent } from '@/lib/sandboxTypes';

interface UseAgentTelemetryOptions {
  projectId?: string | null;
  sessionId?: string | null;
  enabled?: boolean;
  pollFallbackMs?: number;
  /** Poll global engine fleet when no session/project context (ConsoleShell header). */
  globalMode?: boolean;
}

interface UseAgentTelemetryResult {
  sandboxes: AgentSandbox[];
  connected: boolean;
  latencyMs: number | null;
  error: string | null;
  updateSandbox: (agentId: string, patch: Partial<AgentSandbox>) => void;
}

function smoothLatency(prev: number | null, sample: number): number {
  if (prev == null) return sample;
  return Math.round(prev * 0.7 + sample * 0.3);
}

export function useAgentTelemetry({
  projectId,
  sessionId,
  enabled = true,
  pollFallbackMs = 3000,
  globalMode = false,
}: UseAgentTelemetryOptions): UseAgentTelemetryResult {
  const [sandboxes, setSandboxes] = useState<AgentSandbox[]>([]);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latencyRef = useRef<number | null>(null);

  const streamProjectId = globalMode
    ? 'default'
    : projectId || sessionId || 'default';

  const recordLatency = useCallback((sample: number) => {
    const next = smoothLatency(latencyRef.current, sample);
    latencyRef.current = next;
    setLatencyMs(next);
  }, []);

  const updateSandbox = useCallback((agentId: string, patch: Partial<AgentSandbox>) => {
    setSandboxes((prev) =>
      prev.map((s) => {
        if (s.id === agentId || s.agentId === agentId) {
          return { ...s, ...patch };
        }
        return s;
      })
    );
  }, []);

  const refreshPoll = useCallback(async () => {
    const started = performance.now();
    try {
      const qs = new URLSearchParams();
      if (sessionId) qs.set('sessionId', sessionId);
      if (projectId) qs.set('project_id', projectId);
      const suffix = qs.toString();
      const res = await fetch(
        suffix ? `/api/tasks/sandboxes?${suffix}` : '/api/tasks/sandboxes',
        { cache: 'no-store' },
      );
      recordLatency(performance.now() - started);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.sandboxes)) {
        setSandboxes(data.sandboxes);
      }
    } catch (e: unknown) {
      recordLatency(performance.now() - started);
      setError(e instanceof Error ? e.message : 'telemetry_poll_failed');
    }
  }, [sessionId, projectId, recordLatency]);

  useEffect(() => {
    const hasContext = Boolean(projectId || sessionId || globalMode);
    if (!enabled || !hasContext) return;

    refreshPoll();
    const pollId = setInterval(refreshPoll, pollFallbackMs);

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let disposed = false;

    const connectSse = () => {
      if (disposed) return;
      const sseStarted = performance.now();
      try {
        eventSource = new EventSource(
          `/api/telemetry?projectId=${encodeURIComponent(streamProjectId)}`
        );
        eventSource.onopen = () => {
          setConnected(true);
          reconnectAttempt = 0;
          recordLatency(performance.now() - sseStarted);
        };
        eventSource.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data) as TelemetryEvent;
            if (payload.agentId && payload.payload) {
              updateSandbox(payload.agentId, payload.payload as Partial<AgentSandbox>);
            }
          } catch {
            /* ignore */
          }
        };
        eventSource.addEventListener('heartbeat', () => {
          setConnected(true);
        });
        eventSource.onerror = () => {
          setConnected(false);
          eventSource?.close();
          eventSource = null;
          if (disposed) return;
          // Capped exponential backoff (~30s) with full jitter to avoid reconnect storms.
          const base = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
          const delay = Math.round(base / 2 + Math.random() * (base / 2));
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(connectSse, delay);
        };
      } catch {
        setConnected(false);
      }
    };

    connectSse();

    return () => {
      disposed = true;
      clearInterval(pollId);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      eventSource?.close();
    };
  }, [
    projectId,
    sessionId,
    globalMode,
    streamProjectId,
    enabled,
    pollFallbackMs,
    refreshPoll,
    updateSandbox,
    recordLatency,
  ]);

  return {
    sandboxes,
    connected,
    latencyMs,
    error,
    updateSandbox,
  };
}
