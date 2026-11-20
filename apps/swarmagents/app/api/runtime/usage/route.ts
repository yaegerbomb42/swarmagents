/**
 * Usage and cost meter. Aggregates the durable per-run telemetry logs into
 * per-run and per-day token/cost totals for the caller.
 *
 * GET /api/runtime/usage?days=30&limit=20 -> UsageReport
 *   days: window in UTC days ending today (default 30, max 90).
 *   limit: max per-run entries (default 20, max 200); day totals and the
 *   grand total always cover every run in the window.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { computeUsage } from "../../../../lib/telemetry/usage";
import { routerProviders } from "../../../../lib/providers/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const rawDays = Number(params.get("days") ?? "");
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 30;
  const rawLimit = Number(params.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;

  return NextResponse.json(
    computeUsage({ userId: user, days, limit, providers: routerProviders(user) }),
  );
}
