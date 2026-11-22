/**
 * GET /api/audit — the caller's own security audit log, newest first.
 *
 * Query parameters:
 *   - `limit`  : max rows returned (default 200, max 1000)
 *   - `before` : unix ms timestamp cursor (returns entries strictly older than `before`)
 *   - `action` : exact action (e.g. `login.success`) or prefix ending in `*` / `.` (e.g. `provider.`)
 *   - `result` : `success` | `failure`
 *   - `format` : `json` (default) | `ndjson` (downloadable audit export)
 *
 * Strictly scoped to the authenticated caller (`x-swarm-user`).
 *
 * NOTE: `AuditEntry.ts` is an ISO timestamp string (see lib/audit), so the
 * `before` cursor and `nextCursor` convert through `Date.parse` — entries
 * whose ts does not parse are treated as unfilterable (kept, never dropped
 * by the cursor) and never produce a cursor.
 */

import { NextResponse, type NextRequest } from "next/server";
import { NO_STORE, routeCaller, unauthorizedResponse } from "../../../lib/auth";
import {
  readAuditEntries,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  auditEntryTsMs,
  type AuditEntry,
  type AuditResult,
} from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_FILTER_RE = /^[a-z0-9._*-]{1,64}$/i;

export async function GET(req: NextRequest) {
  const user = routeCaller(req);
  if (!user) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;

  const rawLimit = params.get("limit");
  let limit = DEFAULT_AUDIT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "limit must be a positive number." },
        { status: 400, headers: NO_STORE },
      );
    }
    limit = Math.min(Math.floor(parsed), MAX_AUDIT_LIMIT);
  }

  const rawBefore = params.get("before");
  let beforeTs: number | null = null;
  if (rawBefore !== null) {
    const parsed = Number(rawBefore);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "before must be a positive timestamp in milliseconds." },
        { status: 400, headers: NO_STORE },
      );
    }
    beforeTs = Math.floor(parsed);
  }

  const actionFilter = params.get("action")?.trim() ?? "";
  if (actionFilter && !ACTION_FILTER_RE.test(actionFilter)) {
    return NextResponse.json({ error: "Invalid action filter." }, { status: 400, headers: NO_STORE });
  }

  const resultFilter = params.get("result")?.trim() ?? "";
  if (resultFilter && resultFilter !== "success" && resultFilter !== "failure") {
    return NextResponse.json(
      { error: 'result must be "success" or "failure".' },
      { status: 400, headers: NO_STORE },
    );
  }
  const resultOption: AuditResult | undefined =
    resultFilter === "success" || resultFilter === "failure" ? resultFilter : undefined;

  const format = (params.get("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "ndjson") {
    return NextResponse.json(
      { error: 'format must be "json" or "ndjson".' },
      { status: 400, headers: NO_STORE },
    );
  }

  // Read at most `limit + 1` matching entries, applying all filters inside the
  // store so a match older than any fixed truncation window remains reachable.
  let matches: AuditEntry[] = readAuditEntries(user, {
    limit: limit + 1,
    beforeTs,
    action: actionFilter,
    result: resultOption,
  });

  // A page never splits a run of entries sharing one timestamp: resuming at a
  // timestamp cursor would otherwise skip the rest of that same-ms group. Grow
  // the fetch until the boundary is clean or the log is exhausted.
  let want = limit + 1;
  while (
    want < MAX_AUDIT_LIMIT &&
    matches.length > limit &&
    auditEntryTsMs(matches[limit]) === auditEntryTsMs(matches[limit - 1])
  ) {
    want = matches.length + 1;
    const more = readAuditEntries(user, { limit: want, beforeTs, action: actionFilter, result: resultOption });
    if (more.length === matches.length) break;
    matches = more;
  }

  let end = Math.min(limit, matches.length);
  while (end < matches.length && auditEntryTsMs(matches[end]) === auditEntryTsMs(matches[end - 1])) {
    end += 1;
  }
  const filtered = matches.slice(0, end);

  let nextCursor: number | null = null;
  if (filtered.length > 0 && matches.length > end) {
    const lastMs = auditEntryTsMs(filtered[filtered.length - 1]);
    nextCursor = Number.isNaN(lastMs) ? null : lastMs;
  }

  if (format === "ndjson") {
    const ndjson = filtered.map((e) => JSON.stringify(e)).join("\n") + (filtered.length ? "\n" : "");
    return new Response(ndjson, {
      status: 200,
      headers: {
        ...NO_STORE,
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="swarm-audit.ndjson"',
      },
    });
  }

  return NextResponse.json({ entries: filtered, nextCursor }, { headers: NO_STORE });
}
