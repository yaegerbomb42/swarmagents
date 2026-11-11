import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCostTracker } from '@/lib/engine-service';

export const runtime = 'nodejs';

const RecordBody = z.object({
  provider: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  agentId: z.string().optional(),
});

export async function GET() {
  try {
    const tracker = getCostTracker();
    const stats = tracker.getStats();
    return NextResponse.json({ ok: true, ...stats });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const parsed = RecordBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const tracker = getCostTracker();
    const { provider, inputTokens, outputTokens, agentId } = parsed.data;
    tracker.recordUsage(provider, inputTokens, outputTokens, agentId || 'unknown');
    const stats = tracker.getStats();
    return NextResponse.json({ ok: true, ...stats });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
