/**
 * Host-side web-search endpoint for the agent inside a user's VM.
 *
 * POST /api/runtime/web/<runToken>/search  { query, limit? }
 *
 * The VM's web-search MCP server (lib/harness/web-search-mcp-source.ts)
 * calls this with the per-run token. The server runs the search with the
 * run owner's own configured backend/key (lib/providers/settings.ts) —
 * per-user BYOK, exactly like the LLM gateway: the search key never enters
 * the VM, and one account's key can never serve another's run.
 *
 * Responses are always JSON: { ok: true, results: [{title, url, snippet}] }
 * or { ok: false, error }. A failed search is a tool error for the agent,
 * never a crashed turn.
 */

import { type NextRequest, NextResponse } from "next/server";
import { JsonBodyError, readJsonBody } from "../../../../../../lib/http";
import { readUserSettings } from "../../../../../../lib/providers/settings";
import { authWebCall, checkWebRateLimit, MAX_WEB_BODY_BYTES } from "../../../../../../lib/runtime/web-shared";
import { webSearch, WebSearchError, type WebSearchErrorCode } from "../../../../../../lib/web/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

/** HTTP status per structured search error code. */
function statusForCode(code: WebSearchErrorCode): number {
  switch (code) {
    case "not_configured":
    case "missing_api_key":
    case "invalid_config":
      return 503;
    case "invalid_query":
    case "blocked_url":
      return 400;
    case "timeout":
      return 504;
    case "backend_error":
      return 502;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ runToken: string }> }) {
  const { runToken } = await ctx.params;

  // Auth before reading the body so unauthenticated calls are cheap.
  const caller = authWebCall(req, runToken);
  if (caller instanceof Response) return caller;

  const limited = checkWebRateLimit(caller.owner);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_WEB_BODY_BYTES);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return fail(err.status, err.status === 413 ? "Request body too large." : "Invalid JSON body.");
    }
    return fail(400, "Invalid JSON body.");
  }
  if (!isRecord(body) || typeof body.query !== "string" || body.query.trim() === "") {
    return fail(400, "query must be a non-empty string.");
  }
  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
      ? Math.floor(body.limit)
      : undefined;

  // The run owner's own search config — never a host key, never another
  // account's. Unconfigured accounts get a structured tool error.
  const config = readUserSettings(caller.owner).webSearch;
  if (!config) {
    return fail(503, "Web search is not configured for this account.");
  }

  try {
    const results = await webSearch(config, body.query, limit, {
      cacheScope: `${caller.owner}:${caller.runId}`,
    });
    return NextResponse.json({ ok: true, results }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof WebSearchError) {
      return fail(statusForCode(err.code), err.message);
    }
    return fail(502, "Web search failed.");
  }
}
