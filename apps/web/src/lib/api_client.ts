/**
 * Unified OpenAPI v1 engine client — all dashboard calls route through /api/engine.
 */

import { authHeaders } from '@/lib/auth';
import { engineProxyUrl } from '@/lib/engineOpenApiParity';

export type GroupChatMessage = {
  id: number;
  sender_id: string;
  sender_role: string;
  message_type: string;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: string;
};

export type GroupChatPage = {
  messages: GroupChatMessage[];
  has_more: boolean;
  oldest_id: number | null;
  newest_id: number | null;
  next_before_id: number | null;
  count: number;
};

export type TestConsensusReport = {
  trajectory_id: string;
  resolved: boolean;
  rounds: number;
  winning_patch: string | null;
  elapsed_ms?: number;
  history?: Array<{
    round_num: number;
    patch_hash: string;
    votes_for: number;
    votes_against: number;
    quorum_met: boolean;
  }>;
};

export type ApiClientOptions = {
  basePath?: string;
  signal?: AbortSignal;
};

export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function resolveUrl(path: string, basePath = ''): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const prefixed = basePath ? `${basePath.replace(/\/$/, '')}${normalized}` : normalized;
  return engineProxyUrl(prefixed);
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiClientError('invalid JSON response', res.status, text);
  }
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_FETCH_RETRIES = 3;
const RETRY_BASE_MS = 250;

function retryDelayMs(attempt: number): number {
  return Math.min(8000, RETRY_BASE_MS * 2 ** attempt);
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, init);
    if (!RETRYABLE_STATUSES.has(res.status) || attempt >= MAX_FETCH_RETRIES) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    attempt += 1;
  }
}

export async function apiGet<T>(
  path: string,
  options: ApiClientOptions = {},
): Promise<T> {
  const res = await fetchWithRetry(resolveUrl(path, options.basePath), {
    method: 'GET',
    headers: { ...authHeaders(), Accept: 'application/json' },
    cache: 'no-store',
    signal: options.signal,
  });
  if (!res.ok) {
    throw new ApiClientError(`GET ${path} failed`, res.status, await res.text());
  }
  return parseJson<T>(res);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  options: ApiClientOptions = {},
): Promise<T> {
  const res = await fetchWithRetry(resolveUrl(path, options.basePath), {
    method: 'POST',
    headers: {
      ...authHeaders(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    throw new ApiClientError(`POST ${path} failed`, res.status, await res.text());
  }
  return parseJson<T>(res);
}

/** Typed shortcuts for high-traffic unified v1 routes. */
export const unifiedApi = {
  v1Meta: () =>
    apiGet<{
      version: string;
      title: string;
      openapi_url: string;
      hamiltonian_plan: string;
      groupchat_consensus: string;
    }>('/api/v1/meta'),
  health: () => apiGet<{ status?: string }>('/health'),
  gatewayAudit: () => apiGet<{ path_count: number; router_count: number }>('/api/gateway/audit'),
  episodicMemory: (limit = 20) =>
    apiGet<{ entries: unknown[]; count: number }>(`/api/memory/episodic?limit=${limit}`),
  routerMetrics: () => apiGet<Record<string, unknown>>('/api/quantum/router/metrics'),
  openApiSpec: () => apiGet<Record<string, unknown>>('/openapi.json'),
  hamiltonianPlan: (body: {
    start: string;
    goal: string;
    transitions: Record<string, string[]>;
    action_costs?: Record<string, number>;
  }) =>
    apiPost<{
      ok: boolean;
      plan: { actions: string[]; total_energy: number; steps: unknown[] };
    }>('/api/quantum/hamiltonian/plan', body),
  groupchatConsensus: () =>
    apiGet<{ ok: boolean; consensus: Record<string, unknown> }>('/api/agents/groupchat-consensus'),
  groupchatMessages: (opts: { limit?: number; beforeId?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.beforeId != null) params.set('before_id', String(opts.beforeId));
    const qs = params.toString();
    return apiGet<GroupChatPage>(`/api/v1/groupchat/messages${qs ? `?${qs}` : ''}`);
  },
  groupchatSend: (body: {
    sender_id: string;
    sender_role?: string;
    message_type?: string;
    content: string;
    metadata?: Record<string, unknown>;
  }) =>
    apiPost<{ status: string; message_id: number; timestamp: string }>(
      '/api/v1/groupchat/send',
      body,
    ),
  testConsensus: (demo = true) =>
    apiGet<{ ok: boolean; demo: boolean; report: TestConsensusReport }>(
      `/api/benchmark/test-consensus${demo ? '?demo=1' : ''}`,
    ),
  fleetStatus: () =>
    apiGet<{
      ok: boolean;
      mode: string;
      counts: { pending: number; completed: number; blocked: number };
      next_pending: Array<{ id: string; title: string; priority: number }>;
      active_locks: Array<{ file_path: string; worker_id: string }>;
    }>('/api/v1/fleet/status'),
  launchSnapshot: () =>
    apiGet<{
      ok: boolean;
      readiness_pct: number;
      status: string;
      generated_at: string;
      telemetry: {
        workers_active: number;
        queue_depth: number;
        mode: string;
        modal_apps: number;
      };
      fleet: {
        counts: { pending: number; completed: number; blocked: number };
        next_pending: Array<{ id: string; title: string; priority: number }>;
        active_locks: Array<{ file_path: string; worker_id: string }>;
      };
      missions: Array<{
        id: string;
        label: string;
        budget: string;
        description: string;
        href: string;
      }>;
    }>('/api/launch/snapshot'),
  missionSnapshot: () =>
    apiGet<{
      ok: boolean;
      fleet: {
        mode: string;
        counts: { pending: number; completed: number; blocked: number };
        active_locks: Array<{ file_path: string; worker_id: string }>;
      };
      checkpoints: Array<{ id: string; label: string; status: string; workers?: number }>;
      launch_mode: string;
    }>('/api/mission/snapshot'),
  missionEvents: (limit = 40) =>
    apiGet<{ ok: boolean; events: Array<{ ts: number; kind: string; message: string }> }>(
      `/api/mission/events?limit=${limit}`,
    ),
  missionShell: (command: string, workspace = '.') =>
    apiPost<{
      ok: boolean;
      stdout: string;
      stderr: string;
      exit_code: number;
      timed_out: boolean;
    }>('/api/mission/shell', { command, workspace }),
  fleetStatusV1: () => unifiedApi.fleetStatus(),
  sseLogsUrl: () => resolveUrl('/api/v1/sse/logs'),
  reorderTasks: (taskIds: string[], basePriority = 100) =>
    apiPost<{ ok: boolean; updated: Array<{ id: string; priority: number }>; count: number }>(
      '/api/v1/tasks/reorder',
      { task_ids: taskIds, base_priority: basePriority },
    ),
  audioBriefing: () =>
    apiGet<{
      ok: boolean;
      briefing: string;
      counts: { pending: number; completed: number; blocked: number };
      active_locks: number;
      generated_at: number;
    }>('/api/v1/audio/briefing'),
  decompTree: (body: {
    goal: string;
    deliverable_type?: string;
    time_budget_hours?: number;
    metadata?: Record<string, unknown>;
  }) =>
    apiPost<{
      ok: boolean;
      project_id: string;
      tree_id: string;
      status: string;
      total_nodes: number;
      goal: string;
    }>('/api/v1/decomp/tree', body),
  terminalWsUrl: () => {
    if (typeof window === 'undefined') return 'ws://localhost:8410/api/v1/terminal';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsBase = process.env.NEXT_PUBLIC_ENGINE_WS_URL;
    if (wsBase) return `${wsBase.replace(/\/$/, '')}/api/v1/terminal`;
    return `${proto}//${window.location.host}/api/v1/terminal`;
  },
};

export default unifiedApi;
