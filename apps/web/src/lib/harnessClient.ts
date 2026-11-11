/**
 * Minimal typed client for the durable harness (`engine/api/runs_routes.py`).
 *
 * This is the direction the dashboard is migrating toward: a **viewer** of
 * engine-owned runs, instead of a driver of step-by-step leaf calls.
 * `sessionExecutor.ts` / `decompEngine.ts` / `orchestrator.ts` still own the
 * legacy continuation flow; new surfaces (and refactors) should use this.
 *
 * Server-only: ENGINE_URL is a server env. Browser code goes through the
 * `/api/engine/v1/*` proxy (see hooks/useRunStream.ts).
 */

const ENGINE = (
  process.env.ENGINE_URL ||
  process.env.NEXT_PUBLIC_ENGINE_URL ||
  (process.env.NODE_ENV === 'production' ? 'http://swarm-engine:8400' : 'http://localhost:8400')
).replace(/\/$/, '');

import type { EventsPage, RunSnapshot, StartRunInput } from '@/types/runEvents';

export type { EventsPage, RunSnapshot, StartRunInput } from '@/types/runEvents';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ENGINE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`harness ${init?.method || 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const harnessClient = {
  start: (input: StartRunInput) =>
    req<RunSnapshot>('/v1/runs', { method: 'POST', body: JSON.stringify(input) }),
  status: (runId: string) => req<RunSnapshot>(`/v1/runs/${runId}`),
  events: (runId: string, limit = 200, offset = 0) =>
    req<EventsPage>(`/v1/runs/${runId}/events?limit=${limit}&offset=${offset}`),
  list: () => req<{ ok: boolean; runs: RunSnapshot[] }>('/v1/runs'),
  pause: (runId: string) => req<RunSnapshot>(`/v1/runs/${runId}/pause`, { method: 'POST' }),
  resume: (runId: string) => req<RunSnapshot>(`/v1/runs/${runId}/resume`, { method: 'POST' }),
  cancel: (runId: string) => req<RunSnapshot>(`/v1/runs/${runId}/cancel`, { method: 'POST' }),
  steer: (runId: string, instruction: string) =>
    req<RunSnapshot>(`/v1/runs/${runId}/steer`, {
      method: 'POST',
      // `text` is the v2 contract; `instruction` keeps pre-v2 engines working.
      body: JSON.stringify({ text: instruction, instruction }),
    }),
  interrupt: (runId: string, text?: string) =>
    req<RunSnapshot>(`/v1/runs/${runId}/interrupt`, {
      method: 'POST',
      body: JSON.stringify(text ? { text } : {}),
    }),
  approve: (runId: string, approvalId: string, decision: 'approve' | 'reject') =>
    req<{ ok: boolean }>(`/v1/runs/${runId}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),
  providers: () =>
    req<{ ok: boolean; providers: { name: string; model: string; type: string; weight: number }[] }>(
      '/v1/providers'
    ),
};
