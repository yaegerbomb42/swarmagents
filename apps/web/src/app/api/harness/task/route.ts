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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Harness task façade — the real dispatch + stream surface for the home
 * console. This used to be a stub that returned a fake "dispatched"
 * payload and called no engine at all.
 *
 * POST dispatches through the relentless executor (lib/agentEngine, the
 * same engine /api/agent/execute uses): steps are recorded in the task
 * registry and mirrored onto the local eventBus as they happen, and the
 * call returns immediately with the task id. GET streams a task's real
 * steps over SSE. Nothing here is synthetic: a task with no dispatch has
 * no steps, and token/latency figures only exist when the executor or
 * engine reported them (see the console feed).
 *
 * Provider selection: the chosen backend (provider type or id) is moved
 * to first priority in the provider store — the same ordering the
 * decomposition engine consumes via providersToEngineConfig — and the
 * sync is best-effort pushed to the engine. The executor's LLM itself
 * goes through the engine gateway with its configured deployment model;
 * the pill sets engine priority + the model preference recorded on the
 * task, it does not rewire the executor's gateway call.
 */

const HEARTBEAT_MS = 15000;

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

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      taskId?: string;
      title?: string;
      prompt?: string;
      text?: string;
      provider?: string;
      model?: string;
    };
    const prompt = (body.prompt ?? body.text ?? '').trim();
    const provider = body.provider || null;
    const model = body.model || null;

    let engineSynced = false;
    if (provider) {
      const res = await prioritizeProvider(provider);
      engineSynced = res.engineSynced;
    }

    let task = body.taskId ? getHarnessTask(body.taskId) : undefined;
    if (!task) {
      task = createHarnessTask({
        title: body.title,
        prompt,
        provider,
        model,
      });
    }
    const taskId = task.taskId;

    if (prompt && task.status !== 'running') {
      startHarnessTask(taskId);
      eventBus.task('started', {
        taskId,
        title: task.title,
        provider: task.provider,
        model: task.model,
      });
      const onStep = (step: ExecutionStep) => {
        const view = recordHarnessStep(taskId, step);
        if (view) eventBus.task('step', { taskId, step: view });
      };
      void executeTask(taskId, prompt, '', onStep, 5, 30)
        .then((finalState: ExecutionState) => {
          const status =
            finalState.status === 'completed'
              ? 'completed'
              : finalState.status === 'blocked'
                ? 'blocked'
                : 'failed';
          finishHarnessTask(taskId, status, {
            error: finalState.error,
            finalResult: finalState.finalResult,
          });
          eventBus.task(status, {
            taskId,
            status,
            error: finalState.error,
            finalResult: finalState.finalResult,
          });
        })
        .catch((err: unknown) => {
          finishHarnessTask(taskId, 'failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          eventBus.task('failed', {
            taskId,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return NextResponse.json({
        ok: true,
        harness: 'omnexx-runtime',
        taskId,
        title: task.title,
        provider: task.provider,
        model: task.model,
        status: 'dispatched',
        engineSynced,
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      ok: true,
      harness: 'omnexx-runtime',
      taskId,
      title: task.title,
      provider: task.provider,
      model: task.model,
      status: 'created',
      engineSynced,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown harness error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id') ?? '';

  // No id: honest status — capabilities are what this façade offers, and
  // engineOnline is probed live (short timeout) rather than assumed.
  if (!id) {
    const health = await engineFetch<Record<string, unknown>>('/health', {
      timeoutMs: 2000,
    });
    return NextResponse.json({
      status: 'online',
      harness: 'omnexx',
      engineOnline: health.ok,
      tasks: listHarnessTasks().length,
      capabilities: [
        'ast-semantic-analysis',
        'goap-planning',
        'safe-staging',
        'provider-racing',
        'multi-key-rotation',
      ],
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
    },
  });
}
