import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  title: z.string().min(1),
  description: z.string().optional().default(''),
  requirements: z.array(z.string()).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  mission_description: z.string().optional(),
});

const ActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('schedule'), taskId: z.string().optional() }),
  z.object({ action: z.literal('complete'), taskId: z.string().min(1), result: z.unknown().optional() }),
  z.object({ action: z.literal('fail'), taskId: z.string().min(1), error: z.string().optional() }),
]);

export async function GET(req: NextRequest) {
  return engineProxy(req, '/api/decomposition/projects');
}

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  if (raw && typeof raw === 'object' && 'action' in raw) {
    const parsed = ActionBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
    }
    // Task lifecycle actions map to engine project endpoints; the engine
    // currently has no generic task-action endpoint — mark as planned.
    return NextResponse.json(
      { error: 'not_implemented', planned: true, feature: 'orchestrator-task-actions' },
      { status: 501, headers: { 'X-Planned': 'true' } }
    );
  }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { title, description, requirements, priority, mission_description } = parsed.data;
  return engineProxy(req, '/api/decomposition/projects', {
    mission_description: mission_description ?? (description || title),
    metadata: { title, requirements, priority, source: 'dashboard_orchestrator' },
  });
}
