/**
 * POST /api/runtime/runs/[id]/pause-input
 *
 * User-initiated desktop takeover:
 *   - `action: "pause"` (default) marks the run as user-driven and emits `run.user_takeover`.
 *   - `action: "handback"` clears the flag, emits `run.user_handback`, and posts the
 *     post-takeover notice so the agent re-inspects the screen before acting.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../lib/telemetry/paths";
import { telemetryBus } from "../../../../../../lib/telemetry";
import { getRun } from "../../../../../../lib/runtime/run-store";
import { handbackUserDriving, isUserDriving, setUserDriving } from "../../../../../../lib/runtime/user-driving";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  const run = getRun(id);
  if (!run || run.summary.userId !== user) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  let action = "pause";
  try {
    const body = (await req.json()) as { action?: unknown };
    if (body && typeof body.action === "string") action = body.action;
  } catch {
    // Empty body defaults to "pause".
  }

  if (action !== "pause" && action !== "handback") {
    return NextResponse.json({ error: "action must be 'pause' or 'handback'." }, { status: 400 });
  }

  if (action === "pause") {
    const { newlyActivated, startedAt } = setUserDriving(id);
    if (newlyActivated) {
      telemetryBus.publish(id, { type: "run.user_takeover", data: { startedAt } });
    }
    return NextResponse.json({ ok: true, driving: isUserDriving(id), startedAt });
  }

  const { wasDriving, durationSec, note } = handbackUserDriving(id);
  telemetryBus.publish(id, { type: "run.user_handback", data: { durationSec, note } });
  return NextResponse.json({ ok: true, driving: false, wasDriving, durationSec, note });
}
