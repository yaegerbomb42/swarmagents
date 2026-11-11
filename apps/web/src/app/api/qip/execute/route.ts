import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ExecBody = z.object({
  trajectory: z.object({
    actions: z.array(z.unknown()).min(1),
  }).passthrough(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = ExecBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  return engineProxy(req, '/qip/execute', parsed.data);
}
