import { NextRequest } from 'next/server';

import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Proxy quantum router metrics (branch probabilities + learning stats). */
export async function GET(req: NextRequest) {
  const treeId = req.nextUrl.searchParams.get('tree_id');
  const qs = treeId ? `?tree_id=${encodeURIComponent(treeId)}` : '';
  return engineProxy(req, `/api/quantum/router/metrics${qs}`);
}
