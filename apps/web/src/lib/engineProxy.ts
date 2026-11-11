import { NextRequest, NextResponse } from 'next/server';

/**
 * Thin engine proxy for dashboard API routes: forwards method, body,
 * and Authorization header to the Python engine and streams the response back.
 */
const ENGINE_URL = (
  process.env.ENGINE_URL ||
  process.env.NEXT_PUBLIC_ENGINE_URL ||
  'http://localhost:8410'
).replace(/\/$/, '');

export function forwardAuth(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = req.headers.get('authorization');
  if (auth) headers.Authorization = auth;
  return headers;
}

export async function engineProxy(
  req: NextRequest,
  enginePath: string,
  body?: unknown,
  timeoutMs = 30_000
): Promise<NextResponse> {
  const method = req.method.toUpperCase();
  try {
    const res = await fetch(`${ENGINE_URL}${enginePath}`, {
      method,
      headers: forwardAuth(req),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError';
    return NextResponse.json(
      { error: isTimeout ? 'engine_timeout' : 'engine_unreachable', detail: String(err?.message ?? err) },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
