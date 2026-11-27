import crypto from "node:crypto";
import { NextResponse } from "next/server";

export const REQUEST_ID_HEADER = "x-request-id";

/** Safe inbound request-id token: 4..64 chars of [a-zA-Z0-9._-]. */
const SAFE_REQUEST_ID_RE = /^[a-zA-Z0-9._-]{4,64}$/;

/**
 * Honor an inbound `x-request-id` when it is a safe, bounded token;
 * otherwise mint a fresh UUID.
 */
export function resolveRequestId(
  headers?: { get(name: string): string | null } | null,
): string {
  const raw = headers?.get(REQUEST_ID_HEADER)?.trim() ?? "";
  if (SAFE_REQUEST_ID_RE.test(raw)) return raw;
  return crypto.randomUUID();
}

/** One-way 12-hex-char hash of a user id for access logs (never logs raw ids/tokens). */
export function hashUserId(
  user: string | { id?: string; userId?: string } | null | undefined,
): string {
  const id =
    typeof user === "string"
      ? user
      : user && typeof user === "object"
        ? (user.id ?? user.userId ?? "")
        : "";
  if (!id) return "anon";
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export interface AccessLogFields {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  userId?: string | { id?: string; userId?: string } | null;
}

/** Format a single-line `/api/*` access log with no tokens or request bodies. */
export function formatAccessLogLine(fields: AccessLogFields): string {
  const safePath = fields.path.replace(/[\r\n]/g, "");
  const safeMethod = fields.method.replace(/[^A-Z]/gi, "").toUpperCase() || "GET";
  const dur = Math.max(0, Math.round(fields.durationMs));
  return `[api] method=${safeMethod} path=${safePath} status=${fields.status} durationMs=${dur} requestId=${fields.requestId} user=${hashUserId(fields.userId)}`;
}

/**
 * Build a JSON error response carrying `requestId` in both the JSON body
 * and the `x-request-id` response header.
 */
export function jsonErrorWithRequestId(
  req: { headers: { get(name: string): string | null } },
  body: Record<string, unknown>,
  init: { status: number; headers?: HeadersInit },
): NextResponse {
  const requestId = resolveRequestId(req.headers);
  const headers = new Headers(init.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return NextResponse.json({ ...body, requestId }, { status: init.status, headers });
}
