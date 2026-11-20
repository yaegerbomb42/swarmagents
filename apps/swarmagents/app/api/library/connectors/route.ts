/**
 * The verified connector catalog, plus adding a connector to this account.
 *
 * GET  /api/library/connectors -> {connectors, installedIds}
 * POST /api/library/connectors {connectorId, secrets} -> installs a copy of
 *      that connector's MCP definition into the caller's own library.
 *
 * The catalog carries only field names; values are sealed in the user's
 * account and never appear in any response.
 */

import { NextResponse } from "next/server";
import { CONNECTORS, connectorById, connectorPayload } from "../../../../lib/library/catalog";
import { errorResponse, jsonError, libraryOwner, NO_STORE, readJson, unauthorized } from "../../../../lib/library/http";
import { addInstalledItem, readUserLibrary } from "../../../../lib/library/user-store";
import { isRecord } from "../../../../lib/library/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const installedIds = new Set(
      readUserLibrary(owner).items.map((item) => item.id.replace(/^connector-/, "")),
    );
    return NextResponse.json(
      {
        connectors: CONNECTORS.map((entry) => ({
          ...entry,
          installed: installedIds.has(entry.id),
          canInstall: connectorPayload(entry) !== null,
        })),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.connectorId !== "string") {
      return jsonError("connectorId is required.");
    }
    const entry = connectorById(body.connectorId);
    if (!entry) return jsonError("Unknown connector.", 404);
    const payload = connectorPayload(entry);
    if (!payload) return jsonError("This connector cannot be installed automatically.", 400);
    const item = addInstalledItem(owner, {
      id: `connector-${entry.id}`,
      kind: "connector",
      name: entry.name,
      description: entry.description,
      payload,
      secrets: body.secrets,
      origin: "user",
    });
    return NextResponse.json({ item }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
