import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  agent_id: z.string().optional(),
  agent_role: z.string().optional(),
  prompt: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { agent_role, prompt } = parsed.data;
  return engineProxy(req, '/api/decomposition/projects', {
    mission_description: prompt,
    metadata: {
      title: prompt.slice(0, 80),
      requirements: agent_role ? [agent_role] : [],
      priority: 5,
      source: 'studio_neural_brain',
    },
  });
}
