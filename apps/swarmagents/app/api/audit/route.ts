/**
 * GET /api/audit — the caller's own security audit log, newest first.
 *
 * Query parameters:
 *   - `limit`  : max rows returned (default 200, max 1000)
 *   - `before` : composite cursor "<ms>:<offset>" (returns entries strictly
 *                older than that position); a bare "<ms>" is accepted for
 *                legacy clients and means offset 0
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
 *
 * The cursor is composite ("<ms>:<offset>") because several entries can
 * share one millisecond: the offset says how many entries with that exact
 * ms were already returned, so paging across a same-millisecond boundary
 * neither drops nor repeats an event.
 */

import { NextResponse, type NextRequest } from "next/server";
import { NO_STORE, routeCaller, unauthorizedResponse } from "../../../lib/auth";
import {
  readAuditPage,
  parseAuditCursor,
  auditEntryTsMs,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  type AuditCursor,
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
  let before: AuditCursor | null = null;
  if (rawBefore !== null) {
    before = parseAuditCursor(rawBefore);
    if (!before) {
      return NextResponse.json(
        { error: "before must be a positive timestamp in milliseconds, optionally with :offset." },
        { status: 400, headers: NO_STORE },
      );
    }
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

  // Predicates are pushed into the read path: the reader streams newest to
  // oldest and stops once limit+1 matches are collected, so filtering no
  // longer caps out at the 1,000 newest rows and the request never loads
  // the whole file.
  const page = readAuditPage(user, {
    limit,
    before: before ?? undefined,
    action: actionFilter || undefined,
    result: resultOption,
  });
  const filtered: AuditEntry[] = [...page.entries];
  let nextCursor = page.nextCursor;

  // A page never splits a run of entries sharing one timestamp: resuming at
  // a composite cursor would stay exact, but clients that treat one page as
  // one same-ms group (main's #104 contract) must still see the whole group
  // together. Grow the fetch while the next page starts in the same
  // millisecond, capped like the old whole-file path.
  while (nextCursor && filtered.length < MAX_AUDIT_LIMIT) {
    const cursor = parseAuditCursor(nextCursor);
    if (!cursor) break;
    const following = readAuditPage(user, {
      limit,
      before: cursor,
      action: actionFilter || undefined,
      result: resultOption,
    });
    if (following.entries.length === 0) {
      nextCursor = following.nextCursor;
      break;
    }
    if (auditEntryTsMs(following.entries[0]) !== auditEntryTsMs(filtered[filtered.length - 1])) break;
    filtered.push(...following.entries);
    nextCursor = following.nextCursor;
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
