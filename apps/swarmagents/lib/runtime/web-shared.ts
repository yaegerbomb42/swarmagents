/**
 * Shared auth/rate-limit plumbing for the web-search endpoint
 * (/api/runtime/web/<runToken>/search).
 *
 * Mirrors lib/runtime/llm-shared.ts exactly: the VM authenticates with the
 * short-lived per-run HMAC token (lib/runtime/run-token.ts), and the
 * endpoint additionally verifies the signed run is still the user's active
 * run — that is what makes the token expire with the run. The search rate
 * limit is a separate bucket from the LLM proxy's so a search-heavy run
 * cannot eat its own LLM budget (or vice versa).
 */

import { type NextRequest, NextResponse } from "next/server";
import { USER_HEADER } from "../auth";
import { TokenBucket } from "../rate-limit";
import { verifyRunToken } from "./run-token";
import { getRuntimeManager } from "./manager";

/** Max request body for web-search calls (queries are small; 16 KB is generous). */
export const MAX_WEB_BODY_BYTES = 16 * 1024;

function perMinute(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Per-owner bucket for web search (SWARM_WEB_RATE_LIMIT_PER_MIN, default 30/min). */
const webBucket = new TokenBucket(perMinute("SWARM_WEB_RATE_LIMIT_PER_MIN", 30), 60_000);

/** Result of authenticating a web-search request. */
export interface WebCaller {
  /** Run owner (from the signed token). */
  owner: string;
  runId: string;
}

function authError(message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 401 });
}

/**
 * Verify the per-run token and that its run is still the caller's active run.
 * Returns the caller when authenticated, otherwise an error Response.
 */
export function authWebCall(req: NextRequest, rawToken: string): WebCaller | Response {
  if (!rawToken) {
    return authError("Missing run token.");
  }
  const verified = verifyRunToken(rawToken);
  if (!verified) {
    return authError("Invalid or expired run token.");
  }

  // Defense in depth: if a session header is present (e.g. a browser tab of
  // the same user), it must match the token's owner.
  const headerUser = req.headers.get(USER_HEADER);
  if (headerUser && headerUser !== verified.userId) {
    return authError("Run token does not match the caller.");
  }

  // The token expires with the run: the run must still be this user's active
  // run. A finished/errored/cancelled run rejects immediately.
  if (!getRuntimeManager().isActiveRun(verified.userId, verified.runId)) {
    return authError("Run is not active.");
  }

  return { owner: verified.userId, runId: verified.runId };
}

/** Enforce the per-owner web-search rate limit. Returns an error Response or null. */
export function checkWebRateLimit(owner: string): Response | null {
  const result = webBucket.consume(`web:${owner}`);
  if (result.allowed) return null;
  const res = new NextResponse(
    JSON.stringify({ ok: false, error: "Too many web search requests." }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
  res.headers.set("Retry-After", String(result.retryAfter));
  return res;
}

/** Test hook: reset the web-search rate-limit bucket. */
export function resetWebRateLimit(): void {
  webBucket._clear();
}
