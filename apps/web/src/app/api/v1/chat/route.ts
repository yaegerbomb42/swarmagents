import { NextResponse } from 'next/server';
import { z } from 'zod';
import { engineChat, flattenMessages } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const PostBody = z.object({
  message: z.string().optional(),
  messages: z.array(Message).optional(),
  context: z.array(Message).optional(),
  model_preference: z.string().optional(),
  agent_id: z.string().optional(),
});

export async function GET() {
  // Feed status for polling UI
  return NextResponse.json({
    status: 'online',
    messages: [],
    timestamp: Date.now(),
  });
}

export async function POST(request: Request) {
  const parsed = PostBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  let message = (body.message || '').trim();
  if (!message && body.messages?.length) {
    message = flattenMessages(body.messages);
  } else if (!message && body.context?.length) {
    message = flattenMessages([
      ...body.context,
      ...(body.message ? [{ role: 'user' as const, content: body.message }] : []),
    ]);
  }

  if (!message) {
    return NextResponse.json({ success: false, error: 'message_required' }, { status: 400 });
  }

  const start = Date.now();
  const result = await engineChat({
    message,
    model_preference: body.model_preference,
    agent_id: body.agent_id,
    timeoutMs: 60_000,
  });
  const latencyMs = Date.now() - start;

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error || 'engine_unreachable', latency_ms: latencyMs },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    response: result.content,
    model_used: result.model_used,
    latency_ms: latencyMs,
    source: 'engine',
  });
}
