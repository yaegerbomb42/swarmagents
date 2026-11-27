/**
 * core-17 "Rewind VM": restore a run's auto-checkpoint into the user's VM.
 *
 * POST /api/runtime/runs/<id>/rewind {checkpointSeq|checkpointLabel}
 *   -> 200 {ok, runId, checkpointLabel, vmLabel, stepSeq, restoredAt}
 *
 * Unlike /fork (which seeds a new run from a checkpoint), rewind rolls the
 * user's machine back in place: the workspace returns to the checkpoint's
 * state and the run's telemetry and report stay untouched. Refused while a
 * run is active or queued (the restore would clobber in-flight work) and for
 * a checkpoint that no longer exists.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../lib/telemetry/paths";
import { getRuntimeManager } from "../../../../../../lib/runtime/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 16 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

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

  // Either a step number or a display label identifies the checkpoint.
  const checkpoint =
    typeof body.checkpointSeq === "number"
      ? body.checkpointSeq
      : typeof body.checkpointLabel === "string"
        ? body.checkpointLabel
        : undefined;
  if (checkpoint === undefined) {
    return NextResponse.json(
      { error: "checkpointSeq or checkpointLabel is required." },
      { status: 400 },
    );
  }

  const result = await getRuntimeManager().rewind(user, { runId: id, checkpoint });

  if (!result.ok) {
    const status = /not found/i.test(result.error)
      ? 404
      : /in progress|active|queued/i.test(result.error)
        ? 409
        : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({
    ok: true,
    runId: result.runId,
    checkpointLabel: result.checkpointLabel,
    vmLabel: result.vmLabel,
    undoLabel: result.undoLabel,
    stepSeq: result.stepSeq,
    restoredAt: result.restoredAt,
  });
}
