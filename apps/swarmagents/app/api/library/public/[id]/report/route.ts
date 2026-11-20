/**
 * Report a public item.
 *
 * POST /api/library/public/{id}/report  {reason}
 *
 * Reports are private: clients only learn the count, never who reported or
 * what the individual reasons were. Reporting does not remove the item; an
 * admin decides whether to unpublish it.
 */

import { NextResponse } from "next/server";
import { errorResponse, libraryOwner, NO_STORE, readJson, routeParam, unauthorized } from "../../../../../../lib/library/http";
import { reportPublicItem } from "../../../../../../lib/library/public-store";
import { isRecord } from "../../../../../../lib/library/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const reporter = libraryOwner(request);
  if (!reporter) return unauthorized();
  try {
    const id = await routeParam(context);
    const body = await readJson(request);
    const reason = isRecord(body) ? body.reason : undefined;
    const result = reportPublicItem(id, reporter, reason);
    return NextResponse.json({ reported: true, ...result }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
