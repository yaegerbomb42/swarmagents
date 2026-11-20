/**
 * Approval decision endpoint for the harness risk gate.
 *
 * POST {decision:"approve"|"deny"} -> resolves the pending approval created for
 * an ask-classified tool call (see lib/harness/risk.ts and runner.ts). The run
 * that was paused on approval.required resumes on "approve" and halts on
 * "deny"; an undecided approval auto-expires after its TTL.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth), and
 * the caller must own the approval (same user as the run that created it).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { getApprovalStore } from "../../../../../lib/harness/approvals";
import { recordAudit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 1024;

const NO_STORE = { "cache-control": "no-store" } as const;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return unauthorized();
  const { id } = await ctx.params;

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400, headers: NO_STORE });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }

  const decision = body.decision;
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json(
      { error: 'decision must be "approve" or "deny".' },
      { status: 400, headers: NO_STORE },
    );
  }

  const store = getApprovalStore();
  const approval = store.get(id);
  if (!approval || approval.userId !== user) {
    return NextResponse.json({ error: "Approval not found." }, { status: 404, headers: NO_STORE });
  }
  if (approval.status !== "pending") {
    return NextResponse.json(
      { error: `Approval already ${approval.status}.`, status: approval.status },
      { status: 409, headers: NO_STORE },
    );
  }

  const resolved = store.resolve(id, decision === "approve" ? "approved" : "denied");
  recordAudit({
    user,
    action: decision === "approve" ? "approval.approve" : "approval.deny",
    target: id,
    result: "success",
  });
  return NextResponse.json({ ok: true, status: resolved!.status }, { headers: NO_STORE });
}
