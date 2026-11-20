/**
 * Who the caller is in the Library, and whether they can moderate.
 *
 * GET /api/library/me -> {user, admin, publishLimitPerHour}
 */

import { NextResponse } from "next/server";
import { isLibraryAdmin } from "../../../../lib/library/admin";
import { libraryOwner, NO_STORE, unauthorized } from "../../../../lib/library/http";
import { publishLimitPerHour } from "../../../../lib/library/rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  return NextResponse.json(
    {
      user: owner.startsWith("local_") && owner.includes("@") ? owner.slice("local_".length) : owner,
      admin: isLibraryAdmin(owner),
      publishLimitPerHour: publishLimitPerHour(),
    },
    { headers: NO_STORE },
  );
}
