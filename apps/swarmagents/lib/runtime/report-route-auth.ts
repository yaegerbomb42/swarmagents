/**
 * Shared owner-only auth for the per-run report routes
 * (`app/api/runtime/runs/[id]/report/...`).
 *
 * The report route inlines this today; the receipt routes reuse it so the
 * caller check and the owner check live in exactly one place. Returns the
 * stored report when the caller owns the run, or null (the caller gets a
 * 404 either way — a wrong-owner run is indistinguishable from a missing
 * one, exactly as the report route does it).
 */

import type { NextRequest } from "next/server";
import { USER_HEADER } from "../auth";
import { RUN_ID_RE } from "../telemetry/paths";
import { getRun } from "./run-store";
import { readRunReport } from "./run-report";
import type { RunReport } from "./run-report-types";

/** The `x-swarm-user` caller, or null when unsigned/invalid. */
export function reportCaller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

/** True when `id` is a syntactically valid run id. */
export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

/**
 * Load a run's stored report for its owner, or null when the report does
 * not exist, the id is invalid, or the caller is not the run's owner.
 */
export function loadOwnedReport(id: string, user: string): RunReport | null {
  if (!RUN_ID_RE.test(id)) return null;
  const report = readRunReport(id);
  if (!report) return null;
  const owner = report.userId || getRun(id)?.summary.userId;
  if (!owner || owner !== user) return null;
  return report;
}
