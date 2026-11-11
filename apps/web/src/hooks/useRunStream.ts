'use client';

/**
 * useRunStream — connect a RunStore to a harness run through the dashboard
 * proxy (`/api/engine/v1/runs/{id}/...`).
 *
 * Transport: fetch()+ReadableStream SSE reader instead of EventSource, so we
 * can send the Authorization header (EventSource cannot) and control
 * `since=`/`Last-Event-ID` on every reconnect. Frames: `id: <seq>`,
 * `data: <json>`, `: hb` heartbeats. Legacy engines send `event: <kind>`
 * frames without ids and `event: status` / `data: running` — both handled.
 *
 * Lifecycle: snapshot fetch → REST backlog (paged) → SSE with since=lastSeq →
 * capped exponential backoff on drop; stops after a terminal run.state or
 * when the upstream closes on a terminal snapshot.
 */

import { useEffect, useMemo } from 'react';
import { authHeaders } from '@/lib/auth';
import { getRunStore, type RunStore, useRunView, type RunView } from '@/stores/runStore';
import { TERMINAL_STATUSES, type RunSnapshot } from '@/types/runEvents';

export const ENGINE_PROXY = '/api/engine';

export function runPath(runId: string, suffix = ''): string {
  return `${ENGINE_PROXY}/v1/runs/${encodeURIComponent(runId)}${suffix}`;
}

/* ------------------------------------------------------------------ */
/* SSE parsing                                                          */
/* ------------------------------------------------------------------ */

export interface SseFrame { id?: string; event?: string; data: string; retry?: number }

/** Incremental text/event-stream parser (WHATWG semantics, comments dropped). */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private id?: string;
  private event?: string;
  private retry?: number;
  /** Last id seen (persists across frames, like EventSource.lastEventId). */
  lastEventId?: string;
  comments = 0;

  feed(chunk: string): SseFrame[] {
    this.buf += chunk;
    const out: SseFrame[] = [];
    let nl: number;
    // eslint-disable-next-line no-cond-assign
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf[nl] === '\r' && this.buf[nl + 1] === '\n' ? 2 : 1;
      // a lone trailing \r might be the first half of \r\n: wait for more
      if (this.buf[nl] === '\r' && nl + 1 === this.buf.length) break;
      this.buf = this.buf.slice(nl + sepLen);
      if (line === '') {
        if (this.data.length || this.id != null || this.event != null) {
          if (this.data.length) out.push({ id: this.id, event: this.event, data: this.data.join('\n'), retry: this.retry });
        }
        this.data = []; this.event = undefined; this.id = undefined; this.retry = undefined;
        continue;
      }
      if (line.startsWith(':')) { this.comments++; continue; }
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? '' : line.slice(c + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      else if (field === 'event') this.event = value;
      else if (field === 'id') { if (!value.includes('\0')) { this.id = value; this.lastEventId = value; } }
      else if (field === 'retry') { const n = Number(value); if (Number.isFinite(n)) this.retry = n; }
    }
    return out;
  }
}

/** Convert a frame to a raw record for RunStore.ingest. */
export function frameToRecord(f: SseFrame): unknown | null {
  let parsed: unknown;
  try { parsed = JSON.parse(f.data); } catch { parsed = f.data; }
  if (typeof parsed === 'string') {
    // legacy `event: status\ndata: running`
    if (f.event === 'status' || !f.event) return { kind: 'run.state', status: parsed.trim(), ...(f.id && /^\d+$/.test(f.id) ? { seq: Number(f.id) } : {}) };
    return null;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const r = { ...(parsed as Record<string, unknown>) };
    if (r.seq == null && r.synthetic !== true && f.id && /^-?\d+$/.test(f.id)) r.seq = Number(f.id);
    if (r.kind == null && f.event && f.event !== 'message') r.kind = f.event === 'status' ? 'run.state' : f.event;
    return r;
  }
  return null;
}

export function backoffMs(attempt: number, base = 500, cap = 30_000, rand = Math.random): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(exp * (0.75 + rand() * 0.25));
}

export function streamUrl(runId: string, lastSeq: number, hasServerSeq: boolean): string {
  const q = new URLSearchParams({ stream: '1' });
  if (hasServerSeq && lastSeq >= 0) q.set('since', String(lastSeq));
  return `${runPath(runId, '/events')}?${q.toString()}`;
}

/* ------------------------------------------------------------------ */
/* REST helpers                                                         */
/* ------------------------------------------------------------------ */

function headers(extra?: Record<string, string>): Record<string, string> {
  try { return authHeaders(extra); } catch { return { ...(extra ?? {}) }; }
}

export async function fetchSnapshot(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
  const res = await fetch(runPath(runId), { headers: headers(), cache: 'no-store', signal });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return (await res.json()) as RunSnapshot;
}

/**
 * Page the REST history into the store. v2 engines page by `since=<seq>`
 * (seq > since, oldest first). Pre-v2 engines ignore `since`, so when a page
 * doesn't advance the seq cursor we fall back to `offset` paging.
 * Returns number of records read.
 */
export async function loadHistory(
  store: RunStore, signal?: AbortSignal, pageSize = 1000, maxPages = 100,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let offset = 0;
  let since = 0;
  let useSince = true;
  let read = 0;
  for (let p = 0; p < maxPages; p++) {
    const q = useSince ? `since=${since}` : `offset=${offset}`;
    const res = await fetchImpl(`${runPath(store.runId, '/events')}?limit=${pageSize}&${q}`, {
      headers: headers(), cache: 'no-store', signal,
    });
    if (!res.ok) throw new Error(`events ${res.status}`);
    const body = (await res.json()) as { events?: unknown[] };
    const evs = Array.isArray(body.events) ? body.events : [];
    if (useSince) {
      let maxSeq = since;
      for (const e of evs) {
        const s = (e as { seq?: unknown })?.seq;
        if (typeof s === 'number' && s > maxSeq) maxSeq = s;
      }
      if (evs.length && maxSeq === since) {
        // engine ignored `since` (pre-v2): restart with offset paging
        useSince = false;
        p--;
        continue;
      }
      store.ingest(evs, { fallbackBase: offset });
      since = maxSeq;
    } else {
      store.ingest(evs, { fallbackBase: offset });
    }
    offset += evs.length;
    read += evs.length;
    if (evs.length < pageSize) break;
  }
  return read;
}

export async function postControl(runId: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(runPath(runId, path), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
  if (!res.ok) {
    const detail = (data && typeof data === 'object' && 'detail' in (data as object)) ? String((data as any).detail) : String(text).slice(0, 200);
    throw new Error(`${res.status}${detail ? ` · ${detail}` : ''}`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Stream loop (framework-free; the hook just starts/stops it)          */
/* ------------------------------------------------------------------ */

export interface StreamOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  heartbeatTimeoutMs?: number;
  maxAttempts?: number;
}

export async function runStreamLoop(store: RunStore, signal: AbortSignal, opts: StreamOptions = {}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hbTimeout = opts.heartbeatTimeoutMs ?? 45_000;
  let attempt = 0;
  while (!signal.aborted) {
    if (TERMINAL_STATUSES.has(store.d.status)) { store.setConn({ phase: 'closed' }); return; }
    if (opts.maxAttempts != null && attempt >= opts.maxAttempts) return;
    store.setConn({ phase: attempt ? 'retrying' : 'connecting', attempt });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const kick = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), hbTimeout); };
    let gotBytes = false;
    try {
      const d = store.d;
      const h = headers({ Accept: 'text/event-stream' });
      if (d.hasServerSeq && d.lastSeq >= 0) h['Last-Event-ID'] = String(d.lastSeq);
      kick();
      const res = await f(streamUrl(store.runId, d.lastSeq, d.hasServerSeq), { headers: h, cache: 'no-store', signal: ctrl.signal });
      if (!res.ok || !res.body) {
        if (res.status === 404 || res.status === 401 || res.status === 403) {
          store.setConn({ phase: 'error', error: `stream ${res.status}` });
          return;
        }
        throw new Error(`stream ${res.status}`);
      }
      store.setConn({ phase: 'open', attempt, error: undefined });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        kick();
        gotBytes = true;
        const frames = parser.feed(dec.decode(value, { stream: true }));
        const recs = frames.map(frameToRecord).filter((x) => x != null);
        if (recs.length) { store.ingest(recs); attempt = 0; }
        store.conn.lastByteAt = Date.now();
      }
    } catch (err) {
      if (signal.aborted) break;
      store.setConn({ error: (err as Error)?.message ?? 'stream error' });
    } finally {
      if (watchdog) clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) break;
    if (TERMINAL_STATUSES.has(store.d.status)) { store.setConn({ phase: 'closed' }); return; }
    // Legacy engines close without a terminal event: confirm via snapshot.
    try {
      const snapRes = await f(runPath(store.runId), { headers: headers(), cache: 'no-store', signal });
      if (snapRes.ok) {
        const snap = (await snapRes.json()) as RunSnapshot;
        store.applySnapshot(snap);
        if (TERMINAL_STATUSES.has(String(snap.status))) { store.setConn({ phase: 'closed' }); return; }
      }
    } catch { /* ignore */ }
    if (gotBytes) attempt = Math.min(attempt, 1);
    const wait = backoffMs(attempt);
    store.setConn({ phase: 'retrying', attempt: attempt + 1, nextRetryMs: wait });
    attempt++;
    await sleep(wait);
  }
}

/* ------------------------------------------------------------------ */
/* Hook                                                                 */
/* ------------------------------------------------------------------ */

export type StreamMode = 'live' | 'replay';

export function useRunStream(runId: string, mode: StreamMode = 'live'): { store: RunStore; view: RunView } {
  const store = useMemo(() => getRunStore(runId, mode), [runId, mode]);
  const view = useRunView(store);

  useEffect(() => {
    if (!runId) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        store.setConn({ phase: 'connecting', attempt: 0 });
        const snap = await fetchSnapshot(runId, ctrl.signal).catch((e) => {
          store.setConn({ error: (e as Error).message });
          return null;
        });
        if (snap) store.applySnapshot(snap);
        if (store.d.events.length === 0) await loadHistory(store, ctrl.signal);
        if (mode === 'replay') { store.setConn({ phase: 'closed' }); return; }
        await runStreamLoop(store, ctrl.signal);
      } catch (e) {
        if (!ctrl.signal.aborted) store.setConn({ phase: 'error', error: (e as Error).message });
      }
    })();
    return () => ctrl.abort();
  }, [runId, mode, store]);

  return { store, view };
}
