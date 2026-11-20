/**
 * The caller's own installed Library.
 *
 * GET  /api/library/items?kind=   -> {items, notifications}
 * POST /api/library/items         -> add a custom skill/tool/MCP server (or
 *                                    a connector by id) to this account
 *
 * Responses never include secret values: required fields are returned with
 * `configured` and a last-4 mask only. Installed copies keep the version
 * they were installed at; `updateAvailable` says a newer publisher version
 * exists but nothing changes without an explicit install.
 */

import { NextResponse } from "next/server";
import { connectorById, connectorPayload } from "../../../../lib/library/catalog";
import { errorResponse, jsonError, libraryOwner, NO_STORE, readJson, unauthorized } from "../../../../lib/library/http";
import { updateAvailableFor } from "../../../../lib/library/public-store";
import { addInstalledItem, listInstalledItems } from "../../../../lib/library/user-store";
import { isLibraryKind, isRecord, type LibraryKind } from "../../../../lib/library/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const url = new URL(request.url);
    const kindFilter = url.searchParams.get("kind");
    const kind = kindFilter && isLibraryKind(kindFilter) ? kindFilter : null;
    const items = listInstalledItems(owner)
      .filter((item) => !kind || item.kind === kind)
      .map((item) => ({ ...item, ...updateAvailableFor(item) }));
    const notifications = items
      .filter((item) => item.updateAvailable)
      .map((item) => ({
        itemId: item.id,
        name: item.name,
        fromVersion: item.version,
        toVersion: item.latestVersion ?? item.version,
        sourcePublicId: item.sourcePublicId ?? null,
      }));
    return NextResponse.json({ items, notifications }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const body = await readJson(request);
    if (!isRecord(body)) return jsonError("Body must be an object.");
    if (body.connectorId !== undefined) {
      if (typeof body.connectorId !== "string") return jsonError("connectorId must be a string.");
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
    }
    const kind: LibraryKind | null = isLibraryKind(body.kind) ? body.kind : null;
    if (!kind) return jsonError("kind must be skill, tool, mcp or connector.");
    if (typeof body.name !== "string") return jsonError("name is required.");
    if (body.payload === undefined) return jsonError("payload is required.");
    const origin = body.origin === "agent" ? "agent" : "user";
    const item = addInstalledItem(owner, {
      kind,
      name: body.name,
      description: typeof body.description === "string" ? body.description : "",
      license: typeof body.license === "string" ? body.license : undefined,
      payload: body.payload,
      secrets: body.secrets,
      origin,
    });
    return NextResponse.json({ item }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
