import { NextRequest } from 'next/server';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return engineProxy(req, '/api/decomposition/agents/statistics');
}
