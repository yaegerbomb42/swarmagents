/**
 * Publish a new version of an item the caller owns.
 *
 * POST /api/library/public/{id}/versions  {sourceItemId} | {payload,changelog?}
 *
 * Installers see `updateAvailable` on their own copy. Their code is not
 * changed until they install again.
 */

import { NextResponse } from "next/server";
import { isLibraryAdmin } from "../../../../../../lib/library/admin";
import { errorResponse, libraryOwner, NO_STORE, readJson, routeParam, unauthorized } from "../../../../../../lib/library/http";
import { findPublicItem, publicItemDetail, publishVersion, attachProofToCurrentVersion } from "../../../../../../lib/library/public-store";
import { resolvePublishInput } from "../../../../../../lib/library/publish";
import { consumePublishRate } from "../../../../../../lib/library/rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const id = await routeParam(context);
    const record = findPublicItem(id);
    if (!record) return NextResponse.json({ error: "Item not found." }, { status: 404, headers: NO_STORE });
    if (record.ownerId !== owner) {
      return NextResponse.json(
        { error: "Only the publisher can publish a new version." },
        { status: 403, headers: NO_STORE },
      );
    }
    const rate = consumePublishRate(owner);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: `Publishing is limited to ${rate.limit} items per hour.`, retryAfter: rate.retryAfter },
        { status: 429, headers: { ...NO_STORE, "retry-after": String(rate.retryAfter) } },
      );
    }
    const body = await readJson(request);
    const input = resolvePublishInput(owner, body, record.kind);
    const updated = publishVersion(id, owner, input);
    // F4: an optional `proofRunId` attaches a signed proof-of-run bundle to
    // the new version (see the publish route for the failure contract).
    let item = publicItemDetail(updated, owner, isLibraryAdmin(owner));
    let proofError: string | undefined;
    const proofRunId =
      typeof (body as Record<string, unknown>).proofRunId === "string"
        ? ((body as Record<string, unknown>).proofRunId as string).trim()
        : "";
    if (proofRunId) {
      try {
        const withProof = attachProofToCurrentVersion(updated, owner, proofRunId);
        item = publicItemDetail(withProof, owner, isLibraryAdmin(owner));
      } catch (error) {
        proofError = error instanceof Error ? error.message : "Could not attach proof.";
      }
    }
    return NextResponse.json(
      { item, ...(proofError ? { proofError } : {}) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
