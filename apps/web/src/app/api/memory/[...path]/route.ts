import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, segments: string[]) {
  const sub = segments.join('/');
  const search = req.nextUrl.search;
  const enginePath = `/api/memory/${sub}${search}`;

  const init: RequestInit & { timeoutMs?: number } = {
    method: req.method,
    timeoutMs: 30_000,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.headers = { 'Content-Type': req.headers.get('content-type') || 'application/json' };
    init.body = await req.text();
  }

  const res = await engineFetch(enginePath, init);
  if (res.ok === false) {
    return NextResponse.json({ error: res.error }, { status: res.status || 502 });
  }
  return NextResponse.json(res.data);
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  return proxy(req, (await ctx.params).path);
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  return proxy(req, (await ctx.params).path);
}
