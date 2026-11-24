/**
 * Admin-only review of a public item: clear the "unreviewed" label.
 *
 * POST /api/library/public/{id}/review
 */

import { NextResponse } from "next/server";
import { recordAudit } from "../../../../../../lib/audit";
import { isLibraryAdmin } from "../../../../../../lib/library/admin";
import { errorResponse, libraryOwner, NO_STORE, routeParam, unauthorized } from "../../../../../../lib/library/http";
import { reviewPublicItem } from "../../../../../../lib/library/public-store";

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
    const item = reviewPublicItem(id, actor, { admin: isLibraryAdmin(actor) });
    recordAudit({ user: actor, action: "library.review", target: id, result: "success" });
    return NextResponse.json({ reviewed: true, item }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
