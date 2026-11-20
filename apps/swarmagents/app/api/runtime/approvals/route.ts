/**
 * Pending approval hydration and batch resolution for the harness risk gate.
 *
 * GET  /api/runtime/approvals          -> { approvals: PendingApprovalView[] }
 * POST /api/runtime/approvals          -> { resolved: Array<{ id, status }>, missing: string[] }
 *
 * Scoped strictly to the signed-in caller (`x-swarm-user`). Never exposes
 * another user's pending tool calls or internal store state.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getApprovalStore, type PendingApproval } from "../../../../lib/harness/approvals";
import { recordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_BODY_SIZE = 16 * 1024;
const MAX_BATCH_IDS = 25;

export interface PendingApprovalView {
  id: string;
  runId: string;
  toolName: string;
  action: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toView(item: PendingApproval): PendingApprovalView {
  return {
    id: item.id,
    runId: item.runId,
    toolName: item.toolName,
    action: item.action,
    reason: item.reason,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }

  const runIdFilter = req.nextUrl.searchParams.get("runId")?.trim() || null;
  const store = getApprovalStore();
  const pending = store
    .listPendingForUser(user)
    .filter((item) => !runIdFilter || item.runId === runIdFilter)
    .map(toView);

  return NextResponse.json({ approvals: pending }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400, headers: NO_STORE });
  }
  if (raw.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }

  const decision = body.decision;
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json({ error: 'decision must be "approve" or "deny".' }, { status: 400, headers: NO_STORE });
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_BATCH_IDS) {
    return NextResponse.json(
      { error: `ids must be a non-empty array of up to ${MAX_BATCH_IDS} approval ids.` },
      { status: 400, headers: NO_STORE },
    );
  }

  const uniqueIds = Array.from(
    new Set(body.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)),
  );
  if (uniqueIds.length === 0) {
    return NextResponse.json({ error: "ids must contain valid approval id strings." }, { status: 400, headers: NO_STORE });
  }

  const store = getApprovalStore();
  const targetStatus = decision === "approve" ? "approved" : "denied";
  const resolved: Array<{ id: string; status: string }> = [];
  const missing: string[] = [];

  for (const id of uniqueIds) {
    const item = store.get(id);
    if (!item || item.userId !== user || item.status !== "pending") {
      missing.push(id);
      continue;
    }
    const updated = store.resolve(id, targetStatus);
    if (updated) {
      resolved.push({ id, status: updated.status });
      recordAudit({
        user,
        action: decision === "approve" ? "approval.approve" : "approval.deny",
        target: id,
        result: "success",
      });
    } else {
      missing.push(id);
    }
  }

  return NextResponse.json({ ok: true, resolved, missing }, { headers: NO_STORE });
}
