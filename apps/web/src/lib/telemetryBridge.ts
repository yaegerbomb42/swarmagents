import type { AgentSandbox, TelemetryEvent } from './sandboxTypes';
import { toCanonical } from './status';

interface SseSink {
  write: (data: string) => void;
  closed: boolean;
}

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';
const POLL_MS = 3000;

function workerStatusToSandbox(raw: unknown): AgentSandbox['status'] {
  switch (toCanonical(typeof raw === 'string' ? raw : undefined)) {
    case 'running':
    case 'thinking':
    case 'planning':
    case 'validating':
      return 'running';
    case 'paused':
    case 'blocked':
      return 'paused';
    case 'failed':
      return 'error';
    case 'done':
      return 'done';
    default:
      return 'idle';
  }
}

class TelemetryBridge {
  private sinks: Map<string, Set<SseSink>> = new Map();
  private pollTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastWorkerHash: Map<string, string> = new Map();
  private lastFailoverHash: Map<string, string> = new Map();

  subscribe(projectId: string, sink: SseSink): () => void {
    if (!this.sinks.has(projectId)) {
      this.sinks.set(projectId, new Set());
    }
    this.sinks.get(projectId)!.add(sink);
    this.ensurePoll(projectId);

    return () => {
      const set = this.sinks.get(projectId);
      if (set) {
        set.delete(sink);
        if (set.size === 0) {
          this.sinks.delete(projectId);
          this.stopPoll(projectId);
        }
      }
    };
  }

  broadcast(projectId: string, event: TelemetryEvent): void {
    const set = this.sinks.get(projectId);
    if (!set || set.size === 0) return;

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const sink of set) {
      if (!sink.closed) {
        sink.write(payload);
      }
    }
  }

  private ensurePoll(projectId: string) {
    if (this.pollTimers.has(projectId)) return;

    const poll = async () => {
      const set = this.sinks.get(projectId);
      if (!set || set.size === 0) {
        this.stopPoll(projectId);
        return;
      }

      try {
        const res = await fetch(`${ENGINE_URL}/telemetry`, {
          signal: AbortSignal.timeout(2500),
          cache: 'no-store',
        });
        if (!res.ok) return;

        const body = await res.json();
        const workers: Array<Record<string, unknown>> = body.workers || [];
        const hash = JSON.stringify(workers);
        if (hash === this.lastWorkerHash.get(projectId)) return;
        this.lastWorkerHash.set(projectId, hash);

        const ts = Date.now();
        for (const w of workers) {
          const agentId = String(w.id || w.worker_id || 'unknown');
          const event: TelemetryEvent = {
            type: 'agent_update',
            agentId,
            ts,
            payload: {
              id: agentId,
              agentId,
              nodeId: agentId,
              label: String(w.model || agentId),
              mode: 'shell',
              status: workerStatusToSandbox(w.status),
              model: String(w.model || ''),
              providerId: String(w.provider || ''),
              // Tool-call counts are not reported by /telemetry; never alias tokens into this.
              toolCallCount: Number(w.tool_calls) || 0,
              logs: [],
              // total_tokens is a combined figure, not input tokens; leave tokensIn/Out unset.
            } satisfies Partial<AgentSandbox>,
          };
          this.broadcast(projectId, event);
        }

        const failoverRes = await fetch(`${ENGINE_URL}/llm/failover/events?limit=20`, {
          signal: AbortSignal.timeout(2500),
          cache: 'no-store',
        });
        if (failoverRes.ok) {
          const failoverBody = await failoverRes.json();
          const events: Array<Record<string, unknown>> = failoverBody.events || [];
          const failoverHash = JSON.stringify(events);
          if (failoverHash !== this.lastFailoverHash.get(projectId)) {
            this.lastFailoverHash.set(projectId, failoverHash);
            for (const ev of events) {
              const failoverEvent: TelemetryEvent = {
                type: 'failover',
                agentId: String(ev.provider || 'router'),
                ts: Number(ev.ts || ts) * 1000,
                payload: ev,
              };
              this.broadcast(projectId, failoverEvent);
            }
          }
        }
      } catch {
        /* engine offline — polling continues */
      }
    };

    void poll();
    this.pollTimers.set(projectId, setInterval(() => void poll(), POLL_MS));
  }

  private stopPoll(projectId: string) {
    const timer = this.pollTimers.get(projectId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(projectId);
    }
    this.lastWorkerHash.delete(projectId);
    this.lastFailoverHash.delete(projectId);
  }
}

export const telemetryBridge = new TelemetryBridge();
