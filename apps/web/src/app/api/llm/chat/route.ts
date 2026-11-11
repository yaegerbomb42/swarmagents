/**
 * LLM chat — prefers unified engine `/chat`, returns OpenAI-style `{ content }`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { engineChat, flattenMessages, type EngineChatMessage } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ChatBody {
  messages: EngineChatMessage[];
  temperature?: number;
  max_tokens?: number;
  model_preference?: string;
}

export async function POST(req: NextRequest) {
  let body: ChatBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || !body.messages.length) {
    return NextResponse.json({ error: 'messages_required' }, { status: 400 });
  }

  const message = flattenMessages(body.messages);
  const result = await engineChat({
    message,
    model_preference: body.model_preference,
    timeoutMs: 60_000,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error || 'engine_unreachable',
        detail: 'Unified engine /chat failed',
        source: result.source,
      },
      { status: result.source === 'offline' ? 503 : 502 },
    );
  }

  return NextResponse.json({
    content: result.content,
    model_used: result.model_used,
    source: 'engine',
    raw_ok: true,
  });
}
