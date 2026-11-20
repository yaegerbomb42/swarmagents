/**
 * Download one run's persisted telemetry as NDJSON.
 *
 * GET /api/runtime/runs/<id>/log -> application/x-ndjson attachment. Every
 * persisted event (oldest first, across rotated segments) is one JSON line,
 * redacted again at export time so secrets that reached the log cannot leave
 * in a download. Only the owning user may download; anything else is 404.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../lib/telemetry/paths";
import { getRun } from "../../../../../../lib/runtime/run-store";
import { makeRedactor, redactValue } from "../../../../../../lib/harness/redact";

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

  const redact = makeRedactor({ ...process.env } as Record<string, string>);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        for (const event of run.events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(redactValue(event, redact))}\n`));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="${id}.ndjson"`,
      "Cache-Control": "no-store",
    },
  });
}
