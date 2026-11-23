/**
 * Re-verify a run's audit receipt (owner-only).
 *
 * POST /api/runtime/runs/<id>/report/receipt/verify
 *   -> { ok: true } | { ok: false, failedLink?, reason? }
 *
 * Re-checks the stored receipt's hash chain and HMAC signature via
 * `verifyReceipt` and reports exactly which link fails, if any. With an
 * optional JSON body `{ receipt }`, verifies that exported bundle instead
 * of the stored one (same owner check applies). Never throws: a malformed
 * receipt or body is simply "not verified".
 */

import { NextResponse, type NextRequest } from "next/server";
import { JsonBodyError, readJsonBody } from "../../../../../../../../lib/http";
import { isValidRunId, loadOwnedReport, reportCaller } from "../../../../../../../../lib/runtime/report-route-auth";
import { verifyReceipt } from "../../../../../../../../lib/runtime/run-receipt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = reportCaller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const { id } = await ctx.params;
  if (!isValidRunId(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  const report = loadOwnedReport(id, user);
  if (!report) return NextResponse.json({ error: "Run report not found." }, { status: 404 });
  if (!report.receipt) return NextResponse.json({ error: "Run receipt not found." }, { status: 404 });

  // An exported bundle may be supplied for verification; otherwise the
  // stored receipt is re-checked. A malformed body falls back to stored.
  // An oversized body is rejected outright (it is not a malformed receipt).
  let candidate: unknown = report.receipt;
  try {
    const body: unknown = await readJsonBody(req);
    if (body && typeof body === "object" && "receipt" in body) {
      candidate = (body as Record<string, unknown>).receipt;
    }
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    // Empty / non-JSON body: verify the stored receipt.
  }

  return NextResponse.json(verifyReceipt(candidate));
}
