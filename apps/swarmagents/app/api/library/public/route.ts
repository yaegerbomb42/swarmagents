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
import { isLibraryAdmin } from "../../../../lib/library/admin";
import { errorResponse, libraryOwner, NO_STORE, readJson, unauthorized } from "../../../../lib/library/http";
import { publishItem, listPublicItems, publicItemDetail, attachProofToCurrentVersion } from "../../../../lib/library/public-store";
import { consumePublishRate, publishLimitPerHour } from "../../../../lib/library/rate";
import { resolvePublishInput } from "../../../../lib/library/publish";
import { isLibraryKind } from "../../../../lib/library/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const viewer = libraryOwner(request);
  if (!viewer) return unauthorized();
  const url = new URL(request.url);
  const rawKind = url.searchParams.get("kind") ?? "all";
  const kind = rawKind === "all" || isLibraryKind(rawKind) ? rawKind : "all";
  const sortRaw = url.searchParams.get("sort") ?? "installs";
  const sort =
    sortRaw === "newest" || sortRaw === "updated" || sortRaw === "name" || sortRaw === "installs"
      ? sortRaw
      : "installs";
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const { items, total } = listPublicItems({
    query: url.searchParams.get("q") ?? "",
    kind,
    sort,
    limit: Number.isFinite(limitRaw) ? limitRaw : 50,
    offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
  });
  return NextResponse.json(
    {
      items,
      total,
      canModerate: isLibraryAdmin(viewer),
      publishLimitPerHour: publishLimitPerHour(),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const owner = libraryOwner(request);
  if (!owner) return unauthorized();
  try {
    const body = await readJson(request);
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
    const record = publishItem(owner, resolvePublishInput(owner, body));
    // F4: an optional `proofRunId` attaches a signed proof-of-run bundle to
    // version 1. A proof failure never fails the publish — it is reported
    // as `proofError` so the publisher can retry with a finished run.
    let item = publicItemDetail(record, owner, isLibraryAdmin(owner));
    let proofError: string | undefined;
    const proofRunId =
      typeof (body as Record<string, unknown>).proofRunId === "string"
        ? ((body as Record<string, unknown>).proofRunId as string).trim()
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
