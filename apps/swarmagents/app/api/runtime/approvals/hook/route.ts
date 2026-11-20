/**
 * Synchronous tool-approval endpoint for the in-VM PreToolUse hook.
 *
 * POST /api/runtime/approvals/hook
 *   Authorization: Bearer <per-run token>
 *   { tool_name, tool_input, session_id?, cwd?, tool_use_id? }
 *   -> { decision: "allow" | "deny", reason?, approvalId? }
 *
 * The hook in vm-image/hooks/pre-tool-use.mjs calls this before every tool
 * call and blocks Claude Code until the response arrives. The classifier runs
 * here; an "ask" creates the same approval record the UI already renders and
 * waits for POST /api/runtime/approvals/{id}. Deny/timeout returns a deny
 * verdict and the CLI never executes the tool.
 *
 * Auth is the per-run HMAC token minted by RuntimeManager (the same mechanism
 * the LLM proxy uses), not the session header: the caller is the VM, not a
 * browser. The route additionally requires the signed run to be the user's
 * active run, so a token dies with its run.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { verifyRunToken } from "../../../../../lib/runtime/run-token";
import { getRuntimeManager } from "../../../../../lib/runtime/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOOL_NAME = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized(message: string) {
  return NextResponse.json({ error: message }, { status: 401 });
}

function bearerToken(req: NextRequest): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export async function POST(req: NextRequest) {
  const token = bearerToken(req);
  if (!token) return unauthorized("Missing run token.");

  let verified: { userId: string; runId: string } | null;
  try {
    verified = verifyRunToken(token);
  } catch {
    // Missing SWARM_SESSION_SECRET: treat as unauthenticated, never 500.
    verified = null;
  }
  if (!verified) return unauthorized("Invalid or expired run token.");

  // Defense in depth: a browser session of a different user must not ride the
  // VM's token. (The hook sends no user header; this only guards accidental
  // proxy injection.)
  const headerUser = req.headers.get(USER_HEADER);
  if (headerUser && headerUser !== verified.userId) {
    return unauthorized("Run token does not match the caller.");
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ decision: "deny", reason: "Could not read request body." }, { status: 400 });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ decision: "deny", reason: "Request body too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ decision: "deny", reason: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ decision: "deny", reason: "Body must be a JSON object." }, { status: 400 });
  }

  const toolName = typeof body.tool_name === "string" ? body.tool_name.trim() : "";
  if (!toolName || toolName.length > MAX_TOOL_NAME) {
    return NextResponse.json({ decision: "deny", reason: "tool_name is required." }, { status: 400 });
  }

  const manager = getRuntimeManager();
  if (!manager.isActiveRun(verified.userId, verified.runId)) {
    return unauthorized("Run is not active.");
  }

  const result = await manager.requestToolApproval(
    verified.userId,
    verified.runId,
    toolName,
    body.tool_input ?? {},
  );
  return NextResponse.json(result);
}
