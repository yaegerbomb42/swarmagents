/**
 * Universal Engine Proxy — /api/engine/[...path]
 *
 * Forwards every HTTP method and every path to the Python FastAPI backend.
 * decompositionApi.ts routes client-side calls here as /api/engine/api/decomposition/*
 * which this proxy transparently forwards to ENGINE_URL/api/decomposition/*
 *
 * WebSocket connections are NOT proxied here (Next.js route handlers don't support
 * WS upgrades). The dashboard connects WS directly to ENGINE_URL using getWebSocketUrl().
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = (
  process.env.ENGINE_URL ||
  process.env.NEXT_PUBLIC_ENGINE_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  (process.env.NODE_ENV === 'production' ? 'http://swarm-engine:8400' : 'http://localhost:8400')
).replace(/\/$/, '');

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function OPTIONS(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

async function proxy(req: NextRequest, pathSegments: string[]): Promise<NextResponse> {
  // Reconstruct the downstream path + query string
  const downstreamPath = '/' + (pathSegments ?? []).join('/');
  const search = req.nextUrl.search ?? '';
  const targetUrl = `${ENGINE_URL}${downstreamPath}${search}`;

  // Forward safe request headers (drop host, connection, next-specific headers)
  const forwardHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'transfer-encoding' ||
      lower.startsWith('x-nextjs') ||
      lower.startsWith('x-middleware')
    ) return;
    forwardHeaders[key] = value;
  });

  // Read body for mutating methods
  let body: BodyInit | undefined;
  const method = req.method.toUpperCase();
  if (!['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) {
    try {
      body = await req.arrayBuffer();
      // Don't forward empty bodies
      if ((body as ArrayBuffer).byteLength === 0) body = undefined;
    } catch {
      body = undefined;
    }
  }

  // Harness run API (/v1/runs*): the engine gates mutations with a shared
  // SWARM_API_TOKEN (Bearer wins over X-API-Key there). Keep the token
  // server-side and swap it in for the caller's session bearer, but only for
  // callers that present one (same presence check as lib/serverAuth).
  const runApiToken = (process.env.SWARM_API_TOKEN || '').trim();
  if (runApiToken && downstreamPath.startsWith('/v1/runs')) {
    const callerAuth = req.headers.get('authorization') || '';
    if (!/^Bearer\s+\S+/i.test(callerAuth)) {
      return NextResponse.json({ error: 'Authentication required', code: 'auth_required' }, { status: 401 });
    }
    for (const k of Object.keys(forwardHeaders)) {
      if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key') delete forwardHeaders[k];
    }
    forwardHeaders['Authorization'] = `Bearer ${runApiToken}`;
  }

  // SSE requests must not be cut by the 60s timeout: they live until the
  // client disconnects (req.signal) or the engine closes the stream.
  const wantsStream =
    (req.headers.get('accept') || '').includes('text/event-stream') ||
    req.nextUrl.searchParams.get('stream') === '1';
  if (wantsStream) {
    // Ask for identity so bytes are relayed as they arrive.
    forwardHeaders['accept-encoding'] = 'identity';
    delete forwardHeaders['Accept-Encoding'];
  }

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      // Don't cache — always fresh data from the engine
      cache: 'no-store',
      // Abort if the engine doesn't respond in 60s (tasks can be slow).
      // Streams are bounded by the client connection instead.
      signal: wantsStream ? req.signal : AbortSignal.timeout(60_000),
    });

    // Stream the response back with its original status + headers
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      // Skip hop-by-hop headers
      if (
        lower === 'transfer-encoding' ||
        lower === 'connection' ||
        lower === 'keep-alive' ||
        // fetch() already decoded the body; forwarding these would corrupt it
        lower === 'content-encoding' ||
        lower === 'content-length'
      ) return;
      responseHeaders.set(key, value);
    });

    // Allow the dashboard origin
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

    const isSse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
    if (isSse) {
      responseHeaders.set('Cache-Control', 'no-cache, no-transform');
      responseHeaders.set('X-Accel-Buffering', 'no');
    }
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,Last-Event-ID');

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    if (wantsStream && req.signal.aborted) {
      // Client went away before upstream answered; nothing to report.
      return new NextResponse(null, { status: 499 });
    }
    const isTimeout = err?.name === 'TimeoutError' || err?.code === 'UND_ERR_CONNECT_TIMEOUT';
    console.error(`[engine-proxy] ${method} ${targetUrl} → ${isTimeout ? 'TIMEOUT' : err?.message}`);

    return NextResponse.json(
      {
        error: isTimeout
          ? 'Engine request timed out. Is the Python backend running on ' + ENGINE_URL + '?'
          : `Engine unreachable: ${err?.message}`,
        engine_url: ENGINE_URL,
        path: downstreamPath,
      },
      {
        status: isTimeout ? 504 : 502,
        headers: { 'Access-Control-Allow-Origin': '*' },
      }
    );
  }
}
