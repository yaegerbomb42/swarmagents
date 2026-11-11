/**
 * SwarmConnector — client for the unified Swarm Engine via same-origin `/api/engine`.
 */

import { clientEnginePath } from './engineClient';

export interface RouteRequest {
  prompt: string;
  role?: 'commander' | 'subagent' | 'vision';
  tool_count?: number;
  reasoning_steps?: number;
  task_id?: string;
  agent_id?: string;
  model_preference?: string;
}

export interface RouteResponse {
  success?: boolean;
  response?: string;
  model_used?: string;
  error?: string;
  routing?: {
    model_name: string;
    provider: string;
    cost_estimate: number;
    elo_rating: number;
    difficulty: string;
    confidence: number;
    failure_penalty: number;
    is_ab_test: boolean;
    reasoning: string;
  };
}

export interface RecallResponse {
  entries?: unknown[];
  results?: unknown[];
  context?: Record<string, unknown>;
  axioms?: Array<{
    task_description: string;
    error_message: string;
    resolution: string;
    similarity: number;
  }>;
  lessons?: Array<{
    lesson: string;
    trigger: string;
    confidence: number;
    category?: string;
  }>;
  keyword_hits?: string[];
  note?: string;
}

async function engineFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  const url = clientEnginePath(path);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text || `HTTP ${res.status}`, status: res.status };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, status: 0 };
  }
}

export const swarmConnector = {
  /** Send a command/prompt through engine chat routing */
  command: (command: string) =>
    engineFetch<{ success?: boolean; response?: string; status?: string }>('/chat', {
      method: 'POST',
      body: JSON.stringify({ message: command }),
    }),

  /** Route an LLM call through engine model router (`/chat`) */
  route: (req: RouteRequest) =>
    engineFetch<RouteResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: req.prompt,
        model_preference: req.model_preference || req.role || 'ceo_brain',
        agent_id: req.agent_id || 'dashboard',
      }),
    }),

  /** Query episodic + semantic memory for a task */
  recallFailures: async (taskDescription: string, _k = 5) => {
    const [ep, sem] = await Promise.all([
      engineFetch<RecallResponse>('/memory/episodic'),
      engineFetch<RecallResponse>(
        `/memory/semantic?q=${encodeURIComponent(taskDescription)}`,
      ),
    ]);
    if (ep.ok === false && sem.ok === false) {
      return {
        ok: false as const,
        error: ep.error || sem.error,
        status: ep.status || sem.status,
      };
    }
    return {
      ok: true as const,
      data: {
        entries: ep.ok === true ? ep.data.entries || [] : [],
        results: sem.ok === true ? sem.data.results || [] : [],
        keyword_hits: [taskDescription],
        note:
          (ep.ok === false ? ep.error : undefined) ||
          (sem.ok === false ? sem.error : undefined),
      } satisfies RecallResponse,
    };
  },

  /** Refresh autonomy improvement / failure sync surface */
  syncFailures: (_sinceHours = 24) =>
    engineFetch<Record<string, unknown>>('/autonomy/improvement'),

  /** Telemetry / cost-ish summary from engine */
  costSummary: () => engineFetch<Record<string, unknown>>('/telemetry'),

  /** Per-agent view via agents list (filtered client-side by callers) */
  agentCost: (agentId: string) =>
    engineFetch<Record<string, unknown>>(`/agents/${encodeURIComponent(agentId)}`),

  /** Prefer same-origin SSE bridge; fall back to direct engine WS */
  eventsWsUrl: () => {
    if (typeof window !== 'undefined' && !process.env.NEXT_PUBLIC_ENGINE_URL) {
      return ''; // use /api/events SSE instead
    }
    const base =
      process.env.NEXT_PUBLIC_ENGINE_URL ||
      process.env.ENGINE_URL ||
      'http://localhost:8400';
    return `${base.replace(/^http/, 'ws').replace(/\/$/, '')}/ws/events`;
  },

  eventsSseUrl: () => '/api/events',
};

export default swarmConnector;
