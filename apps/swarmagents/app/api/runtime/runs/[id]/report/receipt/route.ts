/**
 * Exportable audit receipt for a run's report (owner-only).
 *
 * GET /api/runtime/runs/<id>/report/receipt -> RunReceipt | 404
 *
 * Returns the receipt exactly as stored in the run's `report.json` (the
 * hash chain + signature). Only the run's owner can read it. A run whose
 * report has no receipt (written before receipts existed, or receipt
 * build failed at finalize time) answers 404.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isValidRunId, loadOwnedReport, reportCaller } from "../../../../../../../lib/runtime/report-route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = reportCaller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const { id } = await ctx.params;
  if (!isValidRunId(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  const report = loadOwnedReport(id, user);
  if (!report) return NextResponse.json({ error: "Run report not found." }, { status: 404 });
  if (!report.receipt) return NextResponse.json({ error: "Run receipt not found." }, { status: 404 });

  return NextResponse.json(report.receipt);
}
