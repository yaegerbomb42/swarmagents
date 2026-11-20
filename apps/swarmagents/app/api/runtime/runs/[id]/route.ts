/**
 * Replay one run's persisted telemetry.
 *
 * GET /api/runtime/runs/<id>[?from=<seq>] -> {runId, summary, events}
 * `from` returns only events with a greater sequence number, matching the SSE
 * Last-Event-ID semantics.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../lib/telemetry/paths";
import { getRun } from "../../../../../lib/runtime/run-store";
import { makeRedactor, redactValue } from "../../../../../lib/harness/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  const run = getRun(id);
  if (!run || run.summary.userId !== user) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const rawFrom = req.nextUrl.searchParams.get("from") ?? req.headers.get("last-event-id");
  const parsed = rawFrom ? Number(rawFrom) : 0;
  const fromSeq = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  const selected = fromSeq > 0 ? run.events.filter((event) => event.seq > fromSeq) : run.events;
  const redact = makeRedactor({ ...process.env } as Record<string, string>);
  const events = selected.map((event) => redactValue(event, redact));

  return NextResponse.json({ runId: id, summary: redactValue(run.summary, redact), events });
}
