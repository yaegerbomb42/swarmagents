/**
 * Conductor — multi-turn orchestrator with sub-agent spawns.
 * Inference via unified engine `/chat` (model routing).
 *
 * Streaming protocol (SSE):
 *   event: text       data: { delta: string }
 *   event: subagent   data: { id, role, task, status, result? }
 *   event: done       data: { ok: true, source?: string }
 *   event: error      data: { message: string }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';

const ConductorSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).min(1),
  systemPrompt: z.string().optional(),
  enableLearning: z.boolean().optional().default(true),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  model_preference: z.string().optional(),
});
import { getLearningEngine } from '@/lib/learning-engine';
import { engineChat, flattenMessages, type EngineChatMessage } from '@/lib/engineClient';
import { sanitizeUserInput } from '@/lib/decompEngine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ConductorBody {
  messages: EngineChatMessage[];
  systemPrompt?: string;
  enableLearning?: boolean;
  sessionId?: string;
  userId?: string;
  model_preference?: string;
}

const SUBAGENT_SYSTEMS: Record<string, string> = {
  reasoner:
    'You are a Reasoner sub-agent. Given a task, analyze the constraints, list key considerations, and recommend a concrete approach in 2-4 sentences. Be precise and technical.',
  coder:
    'You are a Coder sub-agent. Write a focused code snippet that solves the task. Use TypeScript by default unless the task specifies otherwise. Return only code in a fenced block plus a 1-line explanation.',
  researcher:
    'You are a Researcher sub-agent. Outline what would be checked, with which sources, and summarize what is most likely true based on common knowledge. 2-4 bullets.',
  executor:
    'You are an Executor sub-agent. Produce a numbered checklist of concrete steps a human or automation can execute. Each step must be unambiguous and verifiable.',
  validator:
    'You are a Validator sub-agent. Identify edge cases, failure modes, and acceptance criteria for the task. Output 3-6 bullets.',
  memory:
    'You are a Memory sub-agent. Identify what should be remembered from this exchange and how it should be tagged for retrieval later. 2-4 short bullets.',
  navigator:
    'You are a Navigator sub-agent. Outline the path through the system to accomplish the task, naming likely files/modules and the order of operations.',
  planner:
    'You are a Planner sub-agent. Decompose the task into 3-6 phases with deliverables and dependencies. Be terse.',
};

function sseFormat(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSpawns(text: string): { role: string; task: string }[] {
  const out: { role: string; task: string }[] = [];
  const re = /<spawn\s+role="([^"]+)"\s+task="([^"]+)"\s*\/>/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ role: m[1], task: m[2] });
  }
  return out;
}

async function callEngine(
  messages: EngineChatMessage[],
  systemPrompt?: string,
  modelPreference?: string,
): Promise<{ content: string; ok: boolean; error?: string; model_used?: string }> {
  const message = flattenMessages(messages, systemPrompt);
  const result = await engineChat({
    message,
    model_preference: modelPreference,
    timeoutMs: 90_000,
  });
  if (!result.ok) {
    return { content: '', ok: false, error: result.error };
  }
  return { content: result.content, ok: true, model_used: result.model_used };
}

export async function POST(req: NextRequest) {
  let body: ConductorBody;
  try {
    const parsed = ConductorSchema.parse(await req.json());
    body = {
      ...parsed,
      messages: parsed.messages.map((m) => ({
        ...m,
        content: sanitizeUserInput(m.content),
      })),
      systemPrompt: parsed.systemPrompt
        ? sanitizeUserInput(parsed.systemPrompt)
        : undefined,
    };
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 });
  }

  const {
    messages = [],
    systemPrompt,
    enableLearning = true,
    sessionId,
    userId,
    model_preference,
  } = body;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseFormat(event, data)));

      try {
        let augmentedMessages = messages;
        if (enableLearning) {
          const learningEngine = getLearningEngine();
          const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
          if (lastUserMessage) {
            const context = await learningEngine.retrieveContext(lastUserMessage.content);
            if (context.augmentedPrompt !== lastUserMessage.content) {
              augmentedMessages = messages.map((m) =>
                m === lastUserMessage ? { ...m, content: context.augmentedPrompt } : m,
              );
            }
          }
        }

        const finalMessages: EngineChatMessage[] = systemPrompt
          ? [
              { role: 'system', content: systemPrompt },
              ...augmentedMessages.filter((m) => m.role !== 'system'),
            ]
          : augmentedMessages;

        const result = await callEngine(finalMessages, undefined, model_preference);

        if (!result.ok) {
          push('error', {
            message: `Engine /chat failed: ${result.error || 'unreachable'}. Start the unified engine on :8400.`,
          });
          controller.close();
          return;
        }

        const conductorText = result.content;
        for (const chunk of conductorText.match(/.{1,80}/g) ?? []) {
          push('text', { delta: chunk });
          await new Promise((r) => setTimeout(r, 8));
        }

        const spawns = parseSpawns(conductorText);
        for (let i = 0; i < spawns.length; i++) {
          const s = spawns[i];
          const id = `sa-${Date.now()}-${i}`;
          push('subagent', { id, role: s.role, task: s.task, status: 'spawned' });
          await new Promise((r) => setTimeout(r, 40));
          push('subagent', { id, role: s.role, task: s.task, status: 'running' });

          const sysSub =
            SUBAGENT_SYSTEMS[s.role] ??
            `You are a ${s.role} sub-agent. Address the task tersely.`;
          const subResult = await callEngine(
            [
              { role: 'system', content: sysSub },
              { role: 'user', content: s.task },
            ],
            undefined,
            model_preference,
          );

          if (!subResult.ok) {
            push('subagent', {
              id,
              role: s.role,
              task: s.task,
              status: 'error',
              result: subResult.error ?? 'failed',
            });
          } else {
            push('subagent', {
              id,
              role: s.role,
              task: s.task,
              status: 'done',
              result: subResult.content,
            });
          }
        }

        if (enableLearning && conductorText) {
          const learningEngine = getLearningEngine();
          const lastUser = [...messages].reverse().find((m) => m.role === 'user');
          if (lastUser) {
            await learningEngine.logConversation({
              userPrompt: lastUser.content,
              modelResponse: conductorText,
              taskType: 'conductor',
              sessionId,
              userId,
            });
          }
        }

        push('done', { ok: true, source: 'engine', model_used: result.model_used });
        controller.close();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        push('error', { message: msg });
        controller.close();
      }
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
