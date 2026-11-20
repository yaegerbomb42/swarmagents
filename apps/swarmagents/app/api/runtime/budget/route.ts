/**
 * Answer the "budget reached, continue?" question for a run.
 *
 * POST { runId, decision: "continue" | "stop" }
 *
 * When a run crosses 100% of its per-run budget (perRunBudgetUsd) the LLM
 * gateway holds the next paid call instead of spending the money or failing
 * the run, and asks the owner to decide (see lib/runtime/llm-gateway.ts and
 * lib/runtime/budget-gate.ts):
 *
 *   "continue" — the run may spend past the cap. The gateway resumes the
 *                held call, the run's cap is lifted for the rest of the run,
 *                and the router is told to stop excluding paid providers for
 *                it (the daily cap still applies).
 *   "stop"     — the run ends with a 402 and a clear message; no more paid
 *                calls go out.
 *
 * Auth comes from the middleware-set x-swarm-user header, and the caller must
 * own the run. An undecided decision auto-expires after its TTL and is
 * treated exactly like "stop".
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getRuntimeManager } from "../../../../lib/runtime/manager";
import { getBudgetGate } from "../../../../lib/runtime/budget-gate";
import { sharedRouter } from "../../../../lib/runtime/llm-routing";
import { recordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 1024;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400 });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const runId = typeof body.runId === "string" && RUN_ID_RE.test(body.runId) ? body.runId : null;
  if (!runId) {
    return NextResponse.json({ error: "runId must match [A-Za-z0-9_-]{1,64}." }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== "continue" && decision !== "stop") {
    return NextResponse.json({ error: 'decision must be "continue" or "stop".' }, { status: 400 });
  }

  if (!getRuntimeManager().ownsRun(user, runId)) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const gate = getBudgetGate();
  if (!gate.resolve(runId, decision)) {
    return NextResponse.json(
      { error: "No budget decision is pending for this run.", status: gate.pendingFor(runId)?.status ?? "none" },
      { status: 409 },
    );
  }

  if (decision === "continue") {
    // Lift the router's per-run cap for this run as well, so the continuation
    // actually reaches the paid provider (the gateway does the same when it
    // unwinds its own hold).
    try {
      await sharedRouter().grantRunBudgetExemption(user, runId);
    } catch (err) {
      console.warn("[budget] could not exempt the run in the router:", err);
    }
  }

  recordAudit({
    user,
    action: decision === "continue" ? "budget.continue" : "budget.stop",
    target: runId,
    result: "success",
  });

  return NextResponse.json({ ok: true, status: decision === "continue" ? "continued" : "stopped" });
}
