/**
 * F4 — serve one stored proof screenshot.
 *
 * GET /api/library/public/{id}/proof/shots/{index}
 *
 * Proof screenshots are public content (they belong to a published item),
 * but they are only served when the item's current version carries a bundle
 * that still verifies: a tampered or stale bundle yields 404, never the
 * image. No auth is required — the same as viewing the catalog — but an
 * unpublished item stays hidden from everyone but its publisher/admin.
 */

import { isLibraryAdmin } from "../../../../../../../../lib/library/admin";
import { jsonError, libraryOwner, NO_STORE, routeParam } from "../../../../../../../../lib/library/http";
import { findPublicItem, verifiedProofFor } from "../../../../../../../../lib/library/public-store";
import { readProofShot } from "../../../../../../../../lib/library/proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const viewer = libraryOwner(request);
  if (!viewer) return jsonError("Sign in required.", 401);
  const params = await context.params;
  const id = await routeParam(context);
  if (!id || /[/\\]|\.\./.test(id)) return jsonError("Invalid id.", 400);
  const rawIndex = params.index;
  if (!/^\d+$/.test(rawIndex)) return jsonError("Invalid shot index.", 400);
  const index = Number(rawIndex);
  const record = findPublicItem(id);
  if (!record) return jsonError("Item not found.", 404);
  const admin = isLibraryAdmin(viewer);
  if (record.moderation === "unpublished" && record.ownerId !== viewer && !admin) {
    return jsonError("Item not found.", 404);
  }
  // Re-verify on every serve: a bundle that stopped verifying (rotated
  // secret, edited payload, new version) must not keep serving its shots.
  const proof = verifiedProofFor(record);
  if (!proof) return jsonError("No verified proof for this item.", 404);
  if (index < 0 || index >= proof.shots.length) return jsonError("Shot not found.", 404);
  const shot = readProofShot(record.id, record.currentVersion, index);
  if (!shot) return jsonError("Shot not found.", 404);
  if (shot.mime !== proof.shots[index].mime || shot.name !== proof.shots[index].file) {
    return jsonError("Shot not found.", 404);
  }
  return new Response(shot.bytes as unknown as BodyInit, {
    headers: {
      "content-type": shot.mime,
      "content-length": String(shot.bytes.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "content-disposition": "inline",
      ...NO_STORE,
    },
  });
}
