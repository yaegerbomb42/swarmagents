/**
 * Client for the engine's state-graph status endpoints, via the /api/engine proxy.
 * Path base on the engine is /api/state-graph/... — browser hits /api/engine/api/state-graph/...
 */

export type NodeEvent = {
  node: 'pm' | 'coder' | 'verifier' | 'graph' | string;
  event: 'start' | 'enter' | 'exit' | 'complete' | 'fallback' | string;
  step: number;
  timestamp: number;
  detail?: string;
  data?: Record<string, unknown>;
};

export type StateGraphStatus = {
  run_id: string;
  goal: string;
  status: 'queued' | 'running' | 'complete' | 'error';
  current_node: 'queued' | 'pm' | 'coder' | 'verifier' | 'fallback' | 'complete' | string;
  started_at: number;
  finished_at?: number | null;
  error?: string | null;
  project_goal?: string;
  current_tasks?: string[];
  active_task_index?: number;
  code_diffs?: Record<string, string>;
  verification_logs?: string;
  retry_counts?: Record<string, number>;
  logs?: string[];
  node_history?: NodeEvent[];
};

const BASE = '/api/engine/api/state-graph';

export async function startStateGraphRun(goal: string): Promise<{ run_id: string; status: string }> {
  const res = await fetch(`${BASE}/run_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`state-graph run_async failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchStateGraphStatus(runId: string): Promise<StateGraphStatus> {
  const res = await fetch(`${BASE}/status/${encodeURIComponent(runId)}`, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`state-graph status failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}
