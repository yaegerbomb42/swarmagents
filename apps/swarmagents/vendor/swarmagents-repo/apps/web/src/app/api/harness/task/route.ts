import { NextRequest, NextResponse } from 'next/server';
import { executeTask } from '@/lib/agentEngine';
import type { ExecutionStep, ExecutionState } from '@/lib/agentEngine';
import { eventBus } from '@/lib/eventBus';
import {
  createHarnessTask,
  getHarnessTask,
  startHarnessTask,
  recordHarnessStep,
  finishHarnessTask,
  listHarnessTasks,
} from '@/lib/harnessTasks';
import {
  loadProvidersStore,
  saveProvidersStore,
  providersToEngineConfig,
} from '@/lib/providerStore';
import { engineFetch } from '@/lib/engineClient';
import { loadBridge, type BridgeModule, type BridgeTelemetryEvent } from '@/lib/omnexxBridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Harness task façade — dispatch + stream surface for the consoles.
 *
 * Execution: tasks run on the Omnexx engine (packages/engine, loaded from its bundled
 * bridge) over the Nemotron / Mercury key clusters. When the bridge or its keys are not
 * available, the relentless executor (lib/agentEngine) is the fallback.
 *
 * POST, two modes:
 *  - `Accept: text/event-stream` (/console): the response itself is an SSE stream of
 *    `event: telemetry` frames, ending with `task.done` or `task.error`.
 *  - JSON (home console): returns the task id at once; steps are recorded in the task
 *    registry and mirrored onto the eventBus, and GET ?id= streams them over SSE.
 * GET without id: engine status, clusters (key counts only) and capabilities.
 *
 * Access: when HARNESS_ACCESS_TOKEN is set, POST needs `Authorization: Bearer <token>`.
 * Concurrency (HARNESS_MAX_CONCURRENT) and a global hourly cap (HARNESS_MAX_TASKS_PER_HOUR)
 * apply to both modes; the edge middleware adds per-IP rate limits.
 */

const HEARTBEAT_MS = 15000;
const CLUSTER_PROVIDERS = new Set(['auto', 'nemotron', 'mercury', 'race']);
const MAX_PROMPT = 8_000;
const MAX_CONCURRENT = Number(process.env.HARNESS_MAX_CONCURRENT || 4);
const MAX_PER_HOUR = Number(process.env.HARNESS_MAX_TASKS_PER_HOUR || 60);

const g = globalThis as typeof globalThis & { __harnessRunning?: number; __harnessStarted?: number[] };
g.__harnessRunning ??= 0;
g.__harnessStarted ??= [];

function underHourlyCap(now = Date.now()): boolean {
  const started = g.__harnessStarted as number[];
  while (started.length && now - (started[0] as number) > 3_600_000) started.shift();
  return started.length < MAX_PER_HOUR;
}

/** Reserves a run slot synchronously; the returned release is idempotent. */
function reserveSlot(): (() => void) | NextResponse {
  if ((g.__harnessRunning as number) >= MAX_CONCURRENT)
    return NextResponse.json({ ok: false, error: 'Engine is busy, retry shortly' }, { status: 503, headers: { 'Retry-After': '10' } });
  if (!underHourlyCap())
    return NextResponse.json({ ok: false, error: 'Hourly task limit reached' }, { status: 429, headers: { 'Retry-After': '600' } });
  g.__harnessRunning = (g.__harnessRunning as number) + 1;
  (g.__harnessStarted as number[]).push(Date.now());
  let released = false;
  return () => {
    if (!released) {
      released = true;
      g.__harnessRunning = Math.max(0, (g.__harnessRunning as number) - 1);
    }
  };
}

function authorized(req: NextRequest): boolean {
  const required = process.env.HARNESS_ACCESS_TOKEN;
  if (!required) return true;
  return (req.headers.get('authorization') || '') === `Bearer ${required}`;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function prioritizeProvider(
  provider: string,
): Promise<{ matched: boolean; engineSynced: boolean }> {
  try {
    const store = await loadProvidersStore();
    const idx = store.providers.findIndex(
      (p) => (p.type === provider || p.id === provider) && p.enabled,
    );
    if (idx < 0) return { matched: false, engineSynced: false };
    const [picked] = store.providers.splice(idx, 1);
    store.providers.unshift(picked);
    await saveProvidersStore(store);
    try {
      const put = await engineFetch('/api/decomposition/config/providers', {
        method: 'PUT',
        body: JSON.stringify(providersToEngineConfig(store.providers)),
        timeoutMs: 5000,
      });
      if (put.ok) {
        await engineFetch('/api/decomposition/config/providers/reload', {
          method: 'POST',
          timeoutMs: 5000,
        });
      }
      return { matched: true, engineSynced: put.ok };
    } catch {
      return { matched: true, engineSynced: false };
    }
  } catch {
    return { matched: false, engineSynced: false };
  }
}

/** The Omnexx bridge when it is bundled and at least one key cluster is configured. */
async function omnexx(): Promise<BridgeModule | null> {
  try {
    const bridge = await loadBridge();
    return bridge.OmnexxSwarmBridge.clusters(process.env).some((c) => c.keys > 0) ? bridge : null;
  } catch {
    return null;
  }
}

/** Omnexx telemetry → the registry's step shape (what the home console's feed renders). */
function toStep(e: BridgeTelemetryEvent, n: number): ExecutionStep | null {
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  const base = { step: n, timestamp: e.ts };
  switch (e.type) {
    case 'step.model': {
      const t = (e.tokens ?? {}) as Record<string, number>;
      const inTok = (t.uncached ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
      return {
        ...base,
        phase: 'plan',
        reasoning: `turn ${s(e.turn)} · ${s(e.model)} · ${inTok} in / ${t.output ?? 0} out`,
        result: { success: true, output: '', duration_ms: Number(e.ms) || 0 },
      } as ExecutionStep;
    }
    case 'step.thinking':
      return { ...base, phase: 'plan', reasoning: s(e.text) } as ExecutionStep;
    case 'step.tool.done':
      return {
        ...base,
        phase: 'act',
        tool: s(e.tool),
        reasoning: s(e.input).slice(0, 300),
        result: { success: !e.isError, output: `${s(e.bytes)} bytes`, ...(e.isError ? { error: s(e.error) } : {}) },
      } as unknown as ExecutionStep;
    case 'cluster.race.rejected':
    case 'cluster.key.cooldown':
    case 'cluster.key.benched':
      return { ...base, phase: 'retry', reasoning: `${s(e.cluster)} key #${s(e.key)} ${e.type.split('.').pop()}` } as ExecutionStep;
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
  }
  let body: {
    taskId?: string;
    title?: string;
    prompt?: string;
    text?: string;
    description?: string;
    provider?: string;
    model?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  try {
    const prompt = (body.prompt ?? body.text ?? body.description ?? '').trim();
    if (prompt.length > MAX_PROMPT)
      return NextResponse.json({ ok: false, error: `prompt is over ${MAX_PROMPT} characters` }, { status: 413 });
    const provider = body.provider ? String(body.provider).toLowerCase() : null;
    const model = body.model || null;
    const clusterProvider = provider && CLUSTER_PROVIDERS.has(provider) ? provider : 'auto';
    const wantsStream = (req.headers.get('accept') || '').includes('text/event-stream');

    if (wantsStream) {
      if (!prompt) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
      const bridge = await omnexx();
      if (!bridge)
        return NextResponse.json({ ok: false, error: 'Omnexx engine unavailable: bridge bundle or provider keys missing' }, { status: 503 });
      const slot = reserveSlot();
      if (slot instanceof NextResponse) return slot;
      return streamTask(req, bridge, slot, { prompt, title: body.title, provider: clusterProvider, model });
    }

    // Provider pills from the provider store keep their engine-priority sync.
    let engineSynced = false;
    if (provider && !CLUSTER_PROVIDERS.has(provider)) engineSynced = (await prioritizeProvider(provider)).engineSynced;

    let task = body.taskId ? getHarnessTask(body.taskId) : undefined;
    if (!task) task = createHarnessTask({ title: body.title, prompt, provider, model });
    const taskId = task.taskId;
    const reply = (status: string, extra: Record<string, unknown> = {}) =>
      NextResponse.json({
        ok: true,
        harness: 'omnexx-runtime',
        taskId,
        title: task.title,
        provider: task.provider,
        model: task.model,
        status,
        engineSynced,
        timestamp: new Date().toISOString(),
        ...extra,
      });

    if (!prompt || task.status === 'running') return reply('created');

    const slot = reserveSlot();
    if (slot instanceof NextResponse) return slot;
    startHarnessTask(taskId);
    eventBus.task('started', { taskId, title: task.title, provider: task.provider, model: task.model });
    const finish = (status: 'completed' | 'failed' | 'blocked', detail: { error?: string; finalResult?: string }) => {
      finishHarnessTask(taskId, status, detail);
      eventBus.task(status, { taskId, status, ...detail });
    };

    const bridge = await omnexx();
    if (bridge) {
      let n = 0;
      const engine = new bridge.OmnexxSwarmBridge();
      void engine
        .executeTask(
          { id: taskId, title: task.title, description: prompt, provider: clusterProvider, ...(model ? { model } : {}) },
          {
            onEvent: (e) => {
              const step = toStep(e, ++n);
              if (!step) return;
              const view = recordHarnessStep(taskId, step);
              if (view) eventBus.task('step', { taskId, step: view });
            },
          },
        )
        .then((r) => {
          const files = r.files.length ? `\n\nFiles: ${r.files.map((f) => f.path).join(', ')}` : '';
          finish(r.status === 'completed' ? 'completed' : r.status === 'paused' ? 'blocked' : 'failed', {
            ...(r.error ? { error: r.error } : {}),
            finalResult: `${r.finalText}${files}`,
          });
        })
        .catch((err: unknown) => finish('failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(slot);
      return reply('dispatched', { engine: 'omnexx' });
    }

    // Fallback: the relentless executor through the engine gateway.
    const onStep = (step: ExecutionStep) => {
      const view = recordHarnessStep(taskId, step);
      if (view) eventBus.task('step', { taskId, step: view });
    };
    void executeTask(taskId, prompt, '', onStep, 5, 30)
      .then((finalState: ExecutionState) => {
        const status =
          finalState.status === 'completed' ? 'completed' : finalState.status === 'blocked' ? 'blocked' : 'failed';
        finish(status, { error: finalState.error, finalResult: finalState.finalResult });
      })
      .catch((err: unknown) => finish('failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(slot);
    return reply('dispatched', { engine: 'agent-engine' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown harness error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function streamTask(
  req: NextRequest,
  bridge: BridgeModule,
  release: () => void,
  input: { prompt: string; title?: string; provider: string; model: string | null },
): Response {
  const task = createHarnessTask({ title: input.title, prompt: input.prompt, provider: input.provider, model: input.model });
  const taskId = task.taskId;
  startHarnessTask(taskId);
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (e: Record<string, unknown>) => write(`event: telemetry\ndata: ${JSON.stringify(e)}\n\n`);
      const ping = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_MS);
      send({ seq: 0, ts: Date.now(), taskId, type: 'task.accepted', title: task.title, provider: input.provider, harness: 'omnexx-runtime' });
      let n = 0;
      try {
        const r = await new bridge.OmnexxSwarmBridge().executeTask(
          { id: taskId, title: task.title, description: input.prompt, provider: input.provider, ...(input.model ? { model: input.model } : {}) },
          {
            signal: abort.signal,
            onEvent: (e: BridgeTelemetryEvent) => {
              send(e as unknown as Record<string, unknown>);
              const step = toStep(e, ++n);
              if (step) recordHarnessStep(taskId, step);
            },
          },
        );
        finishHarnessTask(taskId, r.status === 'completed' ? 'completed' : r.status === 'paused' ? 'blocked' : 'failed', {
          ...(r.error ? { error: r.error } : {}),
          finalResult: r.finalText,
        });
      } catch (err) {
        finishHarnessTask(taskId, 'failed', { error: err instanceof Error ? err.message : String(err) });
        if (abort.signal.aborted) send({ seq: -1, ts: Date.now(), taskId, type: 'task.done', status: 'cancelled', end: 'stop-now' });
        else send({ seq: -1, ts: Date.now(), taskId, type: 'task.error', message: err instanceof Error ? err.message : 'engine error' });
      } finally {
        release();
        clearInterval(ping);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id') ?? '';

  // No id: honest status — what the engine offers, probed live rather than assumed.
  if (!id) {
    let clusters: { name: string; label: string; model: string; keys: number }[] = [];
    let engine: 'ready' | 'missing' = 'missing';
    let error: string | undefined;
    try {
      clusters = (await loadBridge()).OmnexxSwarmBridge.clusters(process.env);
      engine = 'ready';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const health = await engineFetch<Record<string, unknown>>('/health', { timeoutMs: 2000 });
    const omnexxReady = engine === 'ready' && clusters.some((c) => c.keys > 0);
    return NextResponse.json({
      status: omnexxReady || health.ok ? 'online' : 'degraded',
      harness: 'omnexx',
      engine,
      engineOnline: health.ok,
      clusters,
      running: g.__harnessRunning,
      tasks: listHarnessTasks().length,
      authRequired: Boolean(process.env.HARNESS_ACCESS_TOKEN),
      capabilities: ['agent-loop', 'file-tools', 'provider-racing', 'multi-key-rotation', 'sse-telemetry'],
      ...(error ? { error } : {}),
    });
  }

  const task = getHarnessTask(id);
  if (!task) {
    return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(sse(obj)));
        } catch {
          /* stream closed */
        }
      };
      // Replay recorded history first so a late subscriber sees the run.
      send({ op: 'snapshot', task: getHarnessTask(id) });
      unsub = eventBus.subscribe((evt) => {
        const payload = evt.payload as { taskId?: string } | undefined;
        if (evt.type === 'task' && payload?.taskId === id) {
          send({ op: 'event', event: evt });
        }
      });
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': hb\n\n'));
        } catch {
          /* stream closed */
        }
      }, HEARTBEAT_MS);
      req.signal.addEventListener(
        'abort',
        () => {
          unsub?.();
          unsub = null;
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        { once: true },
      );
    },
    cancel() {
      unsub?.();
      unsub = null;
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
