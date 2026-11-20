/**
 * F1 "Fork Run from Here".
 *
 * POST /api/runtime/runs/<id>/fork {checkpointSeq|checkpointLabel, prompt, model?, fullAuto?}
 *   -> 201 {ok, runId, queued, position?, sourceRunId, checkpointLabel}
 *
 * Spawns a new run seeded from one of the source run's auto-checkpoints
 * (`auto-pre-step-<seq>`). The fork is a fresh run: own runId, fresh
 * conversation, own snapshot lineage. The original run's telemetry and
 * artifacts are untouched — the fork writes only to its own run log.
 *
 * The seed restore waits until the fork actually starts (in the runtime
 * manager), so forking a still-running run queues behind it instead of
 * clobbering the VM under the original. A missing checkpoint is refused
 * here (404) rather than failing at start time.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../lib/telemetry/paths";
import { getRuntimeManager } from "../../../../../../lib/runtime/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;
const MAX_PROMPT_LEN = 200_000;

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
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return NextResponse.json({ error: "prompt is required." }, { status: 400 });
  }
  if (body.prompt.length > MAX_PROMPT_LEN) {
    return NextResponse.json({ error: "prompt is too long." }, { status: 400 });
  }
  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;

  const result = await getRuntimeManager().fork(user, {
    sourceRunId: id,
    checkpoint,
    prompt: body.prompt.trim(),
    ...(model ? { model } : {}),
    ...(typeof body.fullAuto === "boolean" ? { fullAuto: body.fullAuto } : {}),
  });

  if (!result.accepted) {
    const status = /not found/i.test(result.error ?? "") ? 404 : 400;
    return NextResponse.json({ error: result.error ?? "Could not fork run." }, { status });
  }
  return NextResponse.json(
    {
      ok: true,
      runId: result.runId,
      queued: result.queued,
      ...(result.position !== undefined ? { position: result.position } : {}),
      sourceRunId: result.sourceRunId,
      checkpointLabel: result.checkpointLabel,
    },
    { status: 201 },
  );
}
