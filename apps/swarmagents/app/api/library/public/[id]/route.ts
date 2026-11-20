/**
 * One public item, including the full install preview.
 *
 * GET /api/library/public/{id}
 *
 * The response carries the complete SKILL.md/code and the required secret
 * field names. That is deliberate: the installer must be able to read the
 * whole thing before installing. An unpublished item is invisible to
 * everyone except its publisher and admins.
 */

import { NextResponse } from "next/server";
import { isLibraryAdmin } from "../../../../../lib/library/admin";
import { errorResponse, jsonError, libraryOwner, NO_STORE, routeParam, unauthorized } from "../../../../../lib/library/http";
import { findPublicItem, publicItemDetail } from "../../../../../lib/library/public-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const viewer = libraryOwner(request);
  if (!viewer) return unauthorized();
  try {
    const id = await routeParam(context);
    const record = findPublicItem(id);
    if (!record) return jsonError("Item not found.", 404);
    const admin = isLibraryAdmin(viewer);
    if (record.moderation === "unpublished" && record.ownerId !== viewer && !admin) {
      return jsonError("Item not found.", 404);
    }
    return NextResponse.json({ item: publicItemDetail(record, viewer, admin) }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
