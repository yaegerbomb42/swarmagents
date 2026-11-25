/**
 * Host-side connector-enable endpoint for the agent inside a user's VM.
 *
 * POST /api/runtime/connectors/<runToken>/enable  { connectorId }
 *
 * The VM's tool-forge MCP server calls this with the per-run token to
 * activate a zero-key connector mid-run. Keyed connectors are rejected;
 * users must configure them in /connectors.
 *
 * Responses are always JSON: { ok: true, connector, mcpEntries } or
 * { ok: false, error }.
 */

import { type NextRequest, NextResponse } from "next/server";
import { JsonBodyError, readJsonBody } from "../../../../../../lib/http";
import { verifyRunToken } from "../../../../../../lib/runtime/run-token";
import { MAX_WEB_BODY_BYTES } from "../../../../../../lib/runtime/web-shared";
import { findCatalogConnector } from "../../../../../../lib/connectors/catalog";
import { connectConnector, ConnectorError } from "../../../../../../lib/connectors/store";
import { libraryMcpEntries } from "../../../../../../lib/library/run-seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ runToken: string }> }) {
  const { runToken } = await ctx.params;

  const token = verifyRunToken(runToken);
  if (!token) {
    return fail(401, "Invalid or expired run token.");
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_WEB_BODY_BYTES);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return fail(err.status, err.status === 413 ? "Request body too large." : "Invalid JSON body.");
    }
    return fail(400, "Invalid JSON body.");
  }

  if (!isRecord(body) || typeof body.connectorId !== "string" || body.connectorId.trim() === "") {
    return fail(400, "connectorId must be a non-empty string.");
  }
  const connectorId = body.connectorId.trim();

  const entry = findCatalogConnector(connectorId);
  if (!entry) {
    return fail(404, "Unknown connector.");
  }

  if (entry.fields.length !== 0) {
    return fail(403, "Keyed connectors must be configured by the user in /connectors.");
  }

  try {
    const connector = connectConnector(token.userId, connectorId);
    return NextResponse.json(
      { ok: true, connector, mcpEntries: libraryMcpEntries(token.userId) },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof ConnectorError) {
      return fail(err.status, err.message);
    }
    return fail(500, err instanceof Error ? err.message : "Could not enable connector.");
  }
}
