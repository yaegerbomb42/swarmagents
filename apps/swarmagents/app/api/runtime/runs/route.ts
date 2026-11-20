/**
 * Durable run history. Reads the per-run JSONL telemetry logs so runs remain
 * listable after a server restart, unlike the in-memory RuntimeManager view.
 *
 * GET /api/runtime/runs?limit=20&since=<epochMs>&before=<runId|ts>&sessionId=<id>
 *   -> {runs: StoredRunSummary[], nextCursor: string | null}
 * Runs are scoped to the caller and returned newest-first. ?limit defaults to
 * 20 (max 100); ?before is a keyset cursor (a runId or epoch-ms timestamp)
 * that returns only runs strictly before it. nextCursor is the runId of the
 * last returned run, or null when no further page exists. ?sessionId narrows
 * to one thread (a harness sessionId, or a runId for a sessionless run).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getRunSummary, listRuns } from "../../../../lib/runtime/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

function parsePositiveInt(raw: string | null): number | undefined | null {
  // Returns undefined when absent, null when invalid, otherwise the number.
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const params = req.nextUrl.searchParams;

  const rawLimit = parsePositiveInt(params.get("limit"));
  if (rawLimit === null) return badRequest("limit must be a positive integer");
  const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const rawSince = parsePositiveInt(params.get("since"));
  if (rawSince === null) return badRequest("since must be a positive epoch timestamp");

  const rawBefore = params.get("before");
  let before: string | number | undefined;
  if (rawBefore !== null && rawBefore.length > 0) {
    if (/^\d+$/.test(rawBefore)) {
      const tsBefore = parsePositiveInt(rawBefore);
      if (tsBefore === null) return badRequest("before timestamp must be a positive integer");
      before = tsBefore;
    } else {
      // runId cursor: must resolve to a run the caller can see. Read the
      // summary index rather than the full event log.
      const run = getRunSummary(rawBefore);
      if (!run || run.userId !== user) {
        return badRequest("before run id is not a run for this caller");
      }
      before = rawBefore;
    }
  }

  const rawSessionId = params.get("sessionId");
  if (rawSessionId !== null && (rawSessionId.length === 0 || rawSessionId.length > 256)) {
    return badRequest("sessionId must be a non-empty id of at most 256 characters");
  }

  const runs = listRuns({ userId: user, limit, since: rawSince, before, sessionId: rawSessionId ?? undefined });
  const nextCursor = runs.length === limit ? runs[runs.length - 1].runId : null;
  return NextResponse.json({ runs, nextCursor });
}
