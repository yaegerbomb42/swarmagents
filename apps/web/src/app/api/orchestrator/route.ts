import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PostBody = z.object({
  action: z.literal('transition'),
  lifecycle: z.string().min(1),
});

export async function GET(req: NextRequest) {
  return engineProxy(req, '/api/decomposition/workers');
}

export async function POST(req: NextRequest) {
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  return engineProxy(req, '/api/decomposition/workers', parsed.data);
}
