import { authHeaders } from '@/lib/auth';

export interface ConversationTurn {
  id: number;
  user_id: string;
  project_id: string | null;
  run_id: string | null;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  model: string | null;
  created_at: string | null;
}

async function ensureOk(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${what} failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export async function sendConversationTurn(params: {
  content: string;
  projectId?: string;
  runId?: string;
}): Promise<{ turn: ConversationTurn; reply_queued: boolean }> {
  const res = await fetch('/api/conversation/send', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      content: params.content,
      project_id: params.projectId,
      run_id: params.runId,
    }),
  });
  await ensureOk(res, 'sendConversationTurn');
  const data = (await res.json()) as {
    ok: boolean;
    turn: ConversationTurn;
    reply_queued: boolean;
  };
  return { turn: data.turn, reply_queued: data.reply_queued };
}

export async function fetchConversationHistory(params: {
  projectId?: string;
  limit?: number;
}): Promise<ConversationTurn[]> {
  const qs = new URLSearchParams();
  if (params.projectId) qs.set('project_id', params.projectId);
  if (params.limit) qs.set('limit', String(params.limit));
  const res = await fetch(`/api/conversation/history?${qs.toString()}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  await ensureOk(res, 'fetchConversationHistory');
  const data = (await res.json()) as { ok: boolean; turns: ConversationTurn[] };
  return data.turns || [];
}

export async function bindConversationToRun(params: {
  projectId: string;
  runId: string;
}): Promise<number> {
  const res = await fetch('/api/conversation/bind', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ project_id: params.projectId, run_id: params.runId }),
  });
  await ensureOk(res, 'bindConversationToRun');
  const data = (await res.json()) as { ok: boolean; bound: number };
  return data.bound;
}
