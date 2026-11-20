/**
 * One installed Library item: read or remove it.
 *
 * GET    /api/library/items/{id}
 * DELETE /api/library/items/{id}
 *
 * Reads never include secret values. Another account's item resolves to 404.
 */

import { NextResponse } from "next/server";
import { errorResponse, jsonError, libraryOwner, NO_STORE, routeParam, unauthorized } from "../../../../../lib/library/http";
import { updateAvailableFor } from "../../../../../lib/library/public-store";
import { deleteInstalledItem, getInstalledItem } from "../../../../../lib/library/user-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const id = await routeParam(context);
    const item = getInstalledItem(owner, id);
    if (!item) return jsonError("Item not found.", 404);
    return NextResponse.json({ item: { ...item, ...updateAvailableFor(item) } }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const id = await routeParam(context);
    if (!deleteInstalledItem(owner, id)) return jsonError("Item not found.", 404);
    return NextResponse.json({ deleted: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
