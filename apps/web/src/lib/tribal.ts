/**
 * Client for the engine tribal-memory read API (wave-5).
 *
 * The engine mounts these routes at /tribal/* on decomposition_server and the
 * dashboard reaches them through the same-origin /api/engine rewrite — no
 * direct cross-origin calls. Bearer token comes from the cached Firebase
 * session (lib/auth), matching every other engine consumer.
 */
import { authHeaders, engineApiUrl } from '@/lib/auth';

export type TribalRule = {
  id: string;
  rule: string;
  confidence: number;
  learned_at: string | null;
  source_task: string | null;
  source: 'learned' | 'user' | 'agents_md';
  section: string | null;
};

export type TribalRulesResponse = {
  rules: TribalRule[];
  available: boolean;
  count?: number;
};

export type TribalStats = {
  available: boolean;
  total_rules: number;
  learned_rules: number;
  static_rules: number;
  flush_every: number | null;
  tasks_since_flush: number | null;
  last_flush_at: string | null;
  active_modules?: string[];
  disabled?: Record<string, string>;
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(engineApiUrl(path), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`tribal ${path} failed: ${res.status} ${body.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

export function fetchTribalRules(): Promise<TribalRulesResponse> {
  return getJson<TribalRulesResponse>('/tribal/rules');
}

export function fetchTribalStats(): Promise<TribalStats> {
  return getJson<TribalStats>('/tribal/stats');
}

export async function createTribalRule(payload: {
  rule: string;
  section?: string;
  confidence?: number;
}): Promise<{ ok: boolean; rule?: TribalRule; error?: string }> {
  const res = await fetch(engineApiUrl('/tribal/rules'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to create rule: ${res.status} ${body.slice(0, 160)}`);
  }
  return (await res.json()) as { ok: boolean; rule?: TribalRule; error?: string };
}

export async function deleteTribalRule(ruleId: string): Promise<{ ok: boolean; rule_id: string }> {
  const res = await fetch(engineApiUrl(`/tribal/rules/${encodeURIComponent(ruleId)}`), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to delete rule: ${res.status} ${body.slice(0, 160)}`);
  }
  return (await res.json()) as { ok: boolean; rule_id: string };
}

