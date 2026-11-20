/**
 * Shared auth/rate-limit plumbing for the LLM translation endpoints
 * (/api/runtime/llm/<runToken>/v1/messages and .../count_tokens).
 *
 * The VM authenticates with a short-lived per-run HMAC token
 * (lib/runtime/run-token.ts) carried as the Bearer credential in
 * ANTHROPIC_AUTH_TOKEN. The endpoint must additionally verify the signed run
 * is still the user's active run — that is what makes the token expire with
 * the run.
 */

import { type NextRequest, NextResponse } from "next/server";
import { USER_HEADER } from "../auth";
import { TokenBucket } from "../rate-limit";
import { verifyRunToken } from "./run-token";
import { getRuntimeManager } from "./manager";

/** Max request body for LLM proxy calls (8 MB). */
export const MAX_LLM_BODY_BYTES = 8 * 1024 * 1024;

function perMinute(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Per-owner bucket for the LLM proxy (SWARM_LLM_RATE_LIMIT_PER_MIN, default 120/min). */
const llmBucket = new TokenBucket(perMinute("SWARM_LLM_RATE_LIMIT_PER_MIN", 120), 60_000);

/** Result of authenticating an LLM proxy request. */
export interface LlmCaller {
  /** Run owner (from the signed token). */
  owner: string;
  runId: string;
}

/**
 * Verify the per-run token and that its run is still the caller's active run.
 * Returns null when the caller is authenticated, otherwise an error Response.
 */
export function authLlmCall(req: NextRequest, rawToken: string): LlmCaller | Response {
  if (!rawToken) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Missing run token." } }, { status: 401 });
  }
  const verified = verifyRunToken(rawToken);
  if (!verified) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid or expired run token." } }, { status: 401 });
  }

  // Defense in depth: if a session header is present (e.g. a browser tab of
  // the same user), it must match the token's owner.
  const headerUser = req.headers.get(USER_HEADER);
  if (headerUser && headerUser !== verified.userId) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Run token does not match the caller." } }, { status: 401 });
  }

  // The token expires with the run: the run must still be this user's active
  // run. A finished/errored/cancelled run rejects immediately.
  if (!getRuntimeManager().isActiveRun(verified.userId, verified.runId)) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Run is not active." } }, { status: 401 });
  }

  return { owner: verified.userId, runId: verified.runId };
}

/** Enforce the per-owner proxy rate limit. Returns an error Response or null. */
export function checkLlmRateLimit(owner: string): Response | null {
  const result = llmBucket.consume(`llm:${owner}`);
  if (result.allowed) return null;
  const res = new NextResponse(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many LLM proxy requests." } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
  res.headers.set("Retry-After", String(result.retryAfter));
  return res;
}

/** Test hook: reset the proxy rate-limit bucket. */
export function resetLlmRateLimit(): void {
  llmBucket._clear();
}
