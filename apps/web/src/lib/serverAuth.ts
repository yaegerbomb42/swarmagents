/**
 * Server-side helpers for forwarding JWT auth from dashboard API routes to FastAPI.
 */
import { NextRequest, NextResponse } from 'next/server';

export function getBearerToken(request: NextRequest): string | null {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

export function engineForwardHeaders(
  request: NextRequest,
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  };
  const auth = request.headers.get('authorization');
  if (auth) headers.Authorization = auth;
  return headers;
}

export function requireAuth(
  request: NextRequest
): { ok: true; token: string } | { ok: false; response: NextResponse } {
  const token = getBearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Authentication required', code: 'auth_required' },
        { status: 401 }
      ),
    };
  }
  return { ok: true, token };
}
