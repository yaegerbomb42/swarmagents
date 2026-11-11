import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  agentId: z.string().min(1),
  action: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { agentId, action } = parsed.data;
  return engineProxy(req, `/api/decomposition/agents/${encodeURIComponent(agentId)}/action?action=${encodeURIComponent(action)}`, {});
}
