/**
 * Public Library catalog: browse and publish.
 *
 * GET  /api/library/public?q=&kind=&sort=&limit=&offset=
 * POST /api/library/public  {sourceItemId} | {kind,name,description,license,payload}
 *
 * Publishing is rate-limited per account. New items are always labelled
 * "unreviewed". Secret values are rejected; required field names travel with
 * the payload so installers know what to supply.
 */

import { NextResponse } from "next/server";
import { recordAudit } from "../../../../lib/audit";
import { isLibraryAdmin } from "../../../../lib/library/admin";
import { errorResponse, libraryOwner, NO_STORE, readJson, unauthorized } from "../../../../lib/library/http";
import {
  publishItem,
  listPublicItems,
  publicItemDetail,
  attachProofToCurrentVersion,
  clampPublicListLimit,
  clampPublicListOffset,
  cleanText,
} from "../../../../lib/library/public-store";
import { consumePublishRate, publishLimitPerHour } from "../../../../lib/library/rate";
import { resolvePublishInput } from "../../../../lib/library/publish";
import { isLibraryKind, isRecord, LIMITS, LibraryError, normalizePayload } from "../../../../lib/library/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const viewer = libraryOwner(request);
  if (!viewer) return unauthorized();
  try {
    const url = new URL(request.url);
    const rawKind = url.searchParams.get("kind") ?? "all";
    const kind = rawKind === "all" || isLibraryKind(rawKind) ? rawKind : "all";
    const sortRaw = url.searchParams.get("sort") ?? "installs";
    const sort =
      sortRaw === "newest" || sortRaw === "updated" || sortRaw === "name" || sortRaw === "installs"
        ? sortRaw
        : "installs";
    // Clamp before the store so negative / huge query params cannot blow pages.
    const limit = clampPublicListLimit(url.searchParams.get("limit") ?? "50");
    const offset = clampPublicListOffset(url.searchParams.get("offset") ?? "0");
    const admin = isLibraryAdmin(viewer);
    // Unpublished visibility matches GET /api/library/public/[id]: the
    // publisher (and admins) see their own unpublished items; everyone else
    // does not.
    const { items, total } = listPublicItems({
      query: url.searchParams.get("q") ?? "",
      kind,
      sort,
      limit,
      offset,
      viewerId: viewer,
      admin,
    });
    return NextResponse.json(
      {
        items,
        total,
        canModerate: admin,
        publishLimitPerHour: publishLimitPerHour(),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const body = await readJson(request);
    const input = resolvePublishInput(owner, body);
    if (!isLibraryKind(input.kind)) throw new LibraryError("kind must be skill, tool, mcp or connector.");
    normalizePayload(input.kind, input.payload);
    cleanText(input.name, "name", LIMITS.name, true);
    cleanText(input.description, "description", LIMITS.description, false);
    cleanText(input.license, "license", LIMITS.license, false);

    const rate = consumePublishRate(owner);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          error: `Publishing is limited to ${rate.limit} items per hour. Try again in ${Math.ceil(rate.retryAfter / 60)} min.`,
          retryAfter: rate.retryAfter,
        },
        { status: 429, headers: { ...NO_STORE, "retry-after": String(rate.retryAfter) } },
      );
    }
    const record = publishItem(owner, input);
    recordAudit({ user: owner, action: "library.publish", target: record.id, result: "success" });
    // F4: an optional `proofRunId` attaches a signed proof-of-run bundle to
    // version 1. A proof failure never fails the publish — it is reported
    // as `proofError` so the publisher can retry with a finished run.
    let item = publicItemDetail(record, owner, isLibraryAdmin(owner));
    let proofError: string | undefined;
    const proofRunId =
      isRecord(body) && typeof body.proofRunId === "string"
        ? (body.proofRunId as string).trim()
        : "";
    if (proofRunId) {
      try {
        const updated = attachProofToCurrentVersion(record, owner, proofRunId);
        item = publicItemDetail(updated, owner, isLibraryAdmin(owner));
      } catch (error) {
        proofError = error instanceof Error ? error.message : "Could not attach proof.";
      }
    }
    return NextResponse.json(
      { item, remaining: rate.remaining, ...(proofError ? { proofError } : {}) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
