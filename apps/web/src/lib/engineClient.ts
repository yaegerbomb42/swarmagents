/**
 * Server-side helpers for calling the unified SwarmAgents engine.
 * Prefer these over hardcoding ENGINE_URL in route handlers.
 */

export const ENGINE_BASE = (
  process.env.ENGINE_URL ||
  process.env.NEXT_PUBLIC_ENGINE_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  (process.env.NODE_ENV === 'production' ? 'http://swarm-engine:8400' : 'http://localhost:8400')
).replace(/\/$/, '');

export type EngineChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type EngineChatResult = {
  ok: boolean;
  content: string;
  model_used?: string;
  error?: string;
  source: 'engine' | 'offline';
};

/** Flatten OpenAI-style messages into a single user message for engine `/chat`. */
export function flattenMessages(
  messages: EngineChatMessage[],
  systemPrompt?: string,
): string {
  const parts: string[] = [];
  if (systemPrompt?.trim()) {
    parts.push(`[system]\n${systemPrompt.trim()}`);
  }
  for (const m of messages) {
    if (!m?.content?.trim()) continue;
    if (systemPrompt && m.role === 'system') continue;
    parts.push(`[${m.role}]\n${m.content.trim()}`);
  }
  return parts.join('\n\n');
}

export async function engineFetch<T = unknown>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  const { timeoutMs = 30_000, ...rest } = init ?? {};
  const url = `${ENGINE_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: rest.signal ?? ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(rest.headers || {}),
      },
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: text.slice(0, 500) || `HTTP ${res.status}`, status: res.status };
    }
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (e: unknown) {
    clearTimeout(timer);
    const msg = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e);
    return { ok: false, error: msg, status: 0 };
  }
}

/** Call engine `/chat` with model routing. */
export async function engineChat(opts: {
  message: string;
  model_preference?: string;
  agent_id?: string;
  timeoutMs?: number;
}): Promise<EngineChatResult> {
  const result = await engineFetch<{
    success?: boolean;
    response?: string;
    model_used?: string;
    error?: string;
  }>('/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: opts.message,
      model_preference: opts.model_preference,
      agent_id: opts.agent_id,
    }),
    timeoutMs: opts.timeoutMs ?? 60_000,
  });

  if (result.ok === false) {
    return { ok: false, content: '', error: result.error, source: 'offline' };
  }

  const data = result.data;
  if (data.success && data.response) {
    return {
      ok: true,
      content: data.response,
      model_used: data.model_used,
      source: 'engine',
    };
  }

  return {
    ok: false,
    content: '',
    error: data.error || 'engine_chat_failed',
    source: 'engine',
  };
}

/** Same-origin client path helpers (browser → Next proxy → engine). */
export function clientEnginePath(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') {
    return `${ENGINE_BASE}${p}`;
  }
  if (process.env.NEXT_PUBLIC_ENGINE_URL) {
    return `${process.env.NEXT_PUBLIC_ENGINE_URL.replace(/\/$/, '')}${p}`;
  }
  return `/api/engine${p}`;
}
