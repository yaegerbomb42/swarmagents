import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ConfigBody = z.object({
  fastModel: z.string().optional(),
  smartModel: z.string().optional(),
  horizon: z.number().int().positive().optional(),
  simulationMode: z.enum(['fast', 'smart', 'hybrid']).optional(),
  topKTrajectories: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  useIBMQuantum: z.boolean().optional(),
}).strict();

export async function GET(req: NextRequest) {
  return engineProxy(req, '/qip/config');
}

export async function POST(req: NextRequest) {
  const parsed = ConfigBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
  }
  return engineProxy(req, '/qip/config', parsed.data);
}
