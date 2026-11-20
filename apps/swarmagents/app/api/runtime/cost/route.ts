/**
 * Per-run cost and latency dashboard data.
 *
 * GET /api/runtime/cost?runId=<id>
 *   -> { runId, report, budget, pending }
 *
 *   report  — RunCostLatency (lib/telemetry/cost-latency.ts), folded from the
 *             run's durable telemetry log: $ per run and per provider, tokens
 *             in/out, the latency waterfall per call (queued -> first token ->
 *             complete) and the model switch timeline.
 *   budget  — the run's projected cost against its per-run cap
 *             (perRunBudgetUsd, Settings → Router): { limitUsd, spentUsd,
 *             projectedUsd, fraction, status, expectedNextCallUsd }. A null
 *             limitUsd means the user set no cap ("uncapped").
 *   pending — the "budget reached, continue?" decision for this run, when the
 *             gateway is holding a paid call for it (status "pending").
 *
 * Scoped to the caller: the run must belong to them (the same rule as the run
 * stream route), so one account can never read another's spend.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getRuntimeManager } from "../../../../lib/runtime/manager";
import { getBudgetGate } from "../../../../lib/runtime/budget-gate";
import { readUserSettings } from "../../../../lib/providers/settings";
import { getRunsDir } from "../../../../lib/telemetry/paths";
import { readRunEvents } from "../../../../lib/telemetry/run-log";
import {
  aggregateRunCostLatency,
  expectedNextCallUsd,
  projectRunBudget,
} from "../../../../lib/telemetry/cost-latency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const runId = req.nextUrl.searchParams.get("runId") ?? "";
  if (!RUN_ID_RE.test(runId)) {
    return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  }
  if (!getRuntimeManager().ownsRun(user, runId)) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const dir = getRunsDir();
  const events = dir ? readRunEvents(runId, dir) : [];
  const report = aggregateRunCostLatency(runId, events);

  const rawBudget = readUserSettings(user).perRunBudgetUsd;
  const limitUsd =
    typeof rawBudget === "number" && Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : null;
  const expected = expectedNextCallUsd(report);
  const projection = projectRunBudget({
    spentUsd: report.costUsd,
    limitUsd,
    expectedNextCallUsd: expected,
  });

  const pending = getBudgetGate().pendingFor(runId);
  const pendingView =
    pending && pending.status === "pending"
      ? {
          id: pending.id,
          status: pending.status,
          spentUsd: pending.spentUsd,
          limitUsd: pending.limitUsd,
          projectedUsd: pending.projectedUsd,
          createdAt: pending.createdAt,
          expiresAt: pending.expiresAt,
        }
      : null;

  return NextResponse.json({
    runId,
    report,
    budget: { ...projection, expectedNextCallUsd: expected },
    pending: pendingView,
  });
}
