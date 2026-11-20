/**
 * Per-run "Run report" (owner-only).
 *
 * GET /api/runtime/runs/<id>/report -> RunReport | 404
 *
 * The report is created automatically by the runtime when the run finishes
 * (success, failure or stop) and kept server-side under
 * `<runsDir>/reports/<runId>/`. Only the run's owner can read it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../lib/telemetry/paths";
import { getRun } from "../../../../../../lib/runtime/run-store";
import { readRunReport } from "../../../../../../lib/runtime/run-report";
import { readRunAudit } from "../../../../../../lib/lenses/audit";
import { readRunVerification } from "../../../../../../lib/verification/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  const report = readRunReport(id);
  if (!report) return NextResponse.json({ error: "Run report not found." }, { status: 404 });

  // Owner-only: the report's stored owner must match the caller, or the run
  // log (source of truth) must record the caller as the owner.
  const owner = report.userId || getRun(id)?.summary.userId;
  if (!owner || owner !== user) {
    return NextResponse.json({ error: "Run report not found." }, { status: 404 });
  }

  // Attach the auto-audit verdict (from the role's pinned lens) when one has
  // landed, so the UI can surface a pass/warn badge from the same fetch.
  const audit = readRunAudit(id);
  // Attach the shadow-verifier gate result when one ran.
  const verification = readRunVerification(id);
  return NextResponse.json({
    ...report,
    ...(audit ? { audit } : {}),
    ...(verification ? { verification } : {}),
  });
}
