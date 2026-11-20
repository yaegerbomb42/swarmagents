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
import { USER_HEADER } from "../../../lib/auth";
import {
  readAuditEntries,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  type AuditEntry,
} from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const ACTION_FILTER_RE = /^[a-z0-9._*-]{1,64}$/i;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function matchesAction(entryAction: string, filter: string): boolean {
  if (filter.endsWith("*")) {
    return entryAction.startsWith(filter.slice(0, -1));
  }
  if (filter.endsWith(".")) {
    return entryAction.startsWith(filter);
  }
  return entryAction === filter;
}

/** Unix ms for an entry's ISO `ts`; NaN when the stored string does not parse. */
function entryTsMs(entry: AuditEntry): number {
  return Date.parse(entry.ts);
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
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

  const format = (params.get("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "ndjson") {
    return NextResponse.json(
      { error: 'format must be "json" or "ndjson".' },
      { status: 400, headers: NO_STORE },
    );
  }

  // Over-fetch from the store when filters are active so `limit` applies post-filter
  const rawEntries = readAuditEntries(user, { limit: MAX_AUDIT_LIMIT });
  const filtered: AuditEntry[] = [];
  for (const entry of rawEntries) {
    if (beforeTs !== null) {
      const entryMs = entryTsMs(entry);
      if (!Number.isNaN(entryMs) && entryMs >= beforeTs) continue;
    }
    if (actionFilter && !matchesAction(entry.action, actionFilter)) continue;
    if (resultFilter && entry.result !== resultFilter) continue;
    filtered.push(entry);
    if (filtered.length >= limit) break;
  }

  let nextCursor: number | null = null;
  if (filtered.length === limit && filtered.length > 0) {
    const lastMs = entryTsMs(filtered[filtered.length - 1]);
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
