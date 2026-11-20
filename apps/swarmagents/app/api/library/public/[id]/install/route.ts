/**
 * Install a copy of a public item into the caller's own library.
 *
 * POST /api/library/public/{id}/install  {secrets:{FIELD:value}}
 *
 * The current version is deep-copied. Required fields must be supplied by the
 * installer; the values are sealed in the installer's account and never come
 * from the publisher. Re-installing is an explicit update of the caller's own
 * copy (nothing auto-updates).
 */

import { NextResponse } from "next/server";
import { errorResponse, libraryOwner, NO_STORE, readJson, routeParam, unauthorized } from "../../../../../../lib/library/http";
import { installPublicItem } from "../../../../../../lib/library/public-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const installer = libraryOwner(request);
  if (!installer) return unauthorized();
  try {
    const id = await routeParam(context);
    const body = await readJson(request);
    const secrets =
      body && typeof body === "object" && "secrets" in body
        ? (body as { secrets?: unknown }).secrets
        : undefined;
    const { item, publicItem } = installPublicItem(id, installer, secrets);
    return NextResponse.json({ installed: true, item, publicItem }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
