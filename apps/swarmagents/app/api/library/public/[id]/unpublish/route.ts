/**
 * Unpublish a public item.
 *
 * POST /api/library/public/{id}/unpublish
 *
 * Admin-only for moderation. A publisher may always withdraw their own item
 * (that is not moderation, it is taking their work down).
 */

import { NextResponse } from "next/server";
import { isLibraryAdmin } from "../../../../../../lib/library/admin";
import { errorResponse, libraryOwner, NO_STORE, routeParam, unauthorized } from "../../../../../../lib/library/http";
import { unpublishPublicItem } from "../../../../../../lib/library/public-store";
import { recordAudit } from "../../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const actor = libraryOwner(request);
  if (!actor) return unauthorized();
  try {
    const id = await routeParam(context);
    const item = unpublishPublicItem(id, actor, { admin: isLibraryAdmin(actor) });
    recordAudit({
      user: actor,
      action: "library.unpublish",
      target: id,
      result: "success",
    });
    return NextResponse.json({ unpublished: true, item }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
