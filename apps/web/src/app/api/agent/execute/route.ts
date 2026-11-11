// Relentless Agent Execution — SSE streaming endpoint
// POST { task, context?, maxRetries?, maxSteps? }
// Returns Server-Sent Events stream with execution progress

import { NextRequest } from 'next/server';
import { executeTask } from '@/lib/agentEngine';
import type { ExecutionStep, ExecutionState } from '@/lib/agentEngine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { task?: string; context?: string; taskId?: string; maxRetries?: number; maxSteps?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const task = body.task;
  if (!task || typeof task !== 'string') {
    return new Response(JSON.stringify({ error: 'missing task' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const taskId = body.taskId || `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const context = body.context || '';
  const maxRetries = body.maxRetries ?? 5;
  const maxSteps = body.maxSteps ?? 30;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let isClosed = false;
      const send = (event: string, data: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch (e) {
          close();
        }
      };

      const close = () => {
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      };

      // Send initial state
      send('started', { taskId, task, context, maxRetries, maxSteps, startedAt: Date.now() });

      const onStep = (step: ExecutionStep, state: ExecutionState) => {
        send('step', {
          step: step.step,
          phase: step.phase,
          tool: step.tool,
          reasoning: step.reasoning,
          success: step.result?.success,
          output: step.result?.output?.slice(0, 2000),
          error: step.result?.error?.slice(0, 500),
          duration_ms: step.result?.duration_ms,
          retryCount: state.retryCount,
          totalSteps: state.steps.length,
        });
      };

      executeTask(taskId, task, context, onStep, maxRetries, maxSteps)
        .then((finalState) => {
          send('completed', {
            taskId: finalState.taskId,
            status: finalState.status,
            finalResult: finalState.finalResult,
            error: finalState.error,
            totalSteps: finalState.steps.length,
            retryCount: finalState.retryCount,
            duration_ms: (finalState.completedAt || Date.now()) - finalState.startedAt,
          });
          close();
        })
        .catch((err) => {
          send('error', { error: String(err?.message || err) });
          close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// GET endpoint for checking active executions
export async function GET() {
  return new Response(JSON.stringify({
    ok: true,
    engine: 'relentless-execution-v1',
    capabilities: [
      'think', 'shell_exec', 'file_write', 'file_read', 'file_list',
      'web_search', 'browse_url', 'code_generate',
    ],
    config: {
      defaultMaxRetries: 5,
      defaultMaxSteps: 30,
      model: 'deepseek-v4-flash',
      persistence: 'never gives up until done or genuinely blocked',
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
