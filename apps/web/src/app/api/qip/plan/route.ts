import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PlanBody = z.object({
  goal: z.string().min(1),
  currentContext: z.record(z.string(), z.unknown()).optional().default({}),
  availableTools: z.array(z.string()).optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = PlanBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  return engineProxy(req, '/qip/plan', parsed.data);
}
