/**
 * Run Comparison & Regression Diff.
 *
 * GET  /api/runtime/runs/compare?base=<runId>&target=<runId>
 *   -> 200 { comparison }
 *
 * POST /api/runtime/runs/compare
 *   body: { baseRunId: string, targetRunId: string, remember?: boolean, tags?: string[] }
 *   -> 200 { comparison } | 201 { comparison, remembered }
 *
 * Compares two finished runs owned by the signed-in caller (x-swarm-user) across
 * outcome status, cost, latency, provider/model routing, workspace artifact
 * changes, and unresolved blockers. When `remember: true` is passed on POST,
 * a secret-scrubbed benchmark takeaway is stored in the caller's long-term
 * memory and recorded in the audit log.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { recordAudit } from "../../../../../lib/audit";
import { JsonBodyError, readJsonBody } from "../../../../../lib/http";
import { writeMemory } from "../../../../../lib/memory/store";
import { publicFact } from "../../../../../lib/memory/tools";
import { readRunReport } from "../../../../../lib/runtime/run-report";
import type { RunReport } from "../../../../../lib/runtime/run-report-types";
import { getRun } from "../../../../../lib/runtime/run-store";
import { RUN_ID_RE } from "../../../../../lib/telemetry/paths";
import { compareRunReports } from "../../../../../lib/runtime/run-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 48;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePair(
  baseId: unknown,
  targetId: unknown,
): { ok: true; baseId: string; targetId: string } | { ok: false; error: string } {
  if (typeof baseId !== "string" || !baseId.trim() || !RUN_ID_RE.test(baseId.trim())) {
    return { ok: false, error: "A valid base run id is required." };
  }
  if (typeof targetId !== "string" || !targetId.trim() || !RUN_ID_RE.test(targetId.trim())) {
    return { ok: false, error: "A valid target run id is required." };
  }
  const cleanBase = baseId.trim();
  const cleanTarget = targetId.trim();
  if (cleanBase === cleanTarget) {
    return { ok: false, error: "Cannot compare a run with itself." };
  }
  return { ok: true, baseId: cleanBase, targetId: cleanTarget };
}

function loadOwnedReport(
  user: string,
  runId: string,
): { ok: true; report: RunReport } | { ok: false; status: number; error: string } {
  const run = getRun(runId);
  if (!run || run.summary.userId !== user) {
    return { ok: false, status: 404, error: "Run not found." };
  }
  const report = readRunReport(runId);
  if (!report) {
    return {
      ok: false,
      status: 409,
      error: `Run "${runId}" does not have a finished report yet.`,
    };
  }
  return { ok: true, report };
}

function sanitizeTags(raw: unknown): string[] {
  const tags = new Set<string>(["run-comparison"]);
  if (!Array.isArray(raw)) return Array.from(tags);
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const clean = entry
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_TAG_LEN);
    if (clean) tags.add(clean);
    if (tags.size >= MAX_TAGS) break;
  }
  return Array.from(tags);
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  const params = req.nextUrl.searchParams;
  const pair = validatePair(params.get("base"), params.get("target"));
  if (!pair.ok) {
    return NextResponse.json({ error: pair.error }, { status: 400, headers: NO_STORE });
  }

  const baseLoaded = loadOwnedReport(user, pair.baseId);
  if (!baseLoaded.ok) {
    return NextResponse.json({ error: baseLoaded.error }, { status: baseLoaded.status, headers: NO_STORE });
  }
  const targetLoaded = loadOwnedReport(user, pair.targetId);
  if (!targetLoaded.ok) {
    return NextResponse.json(
      { error: targetLoaded.error },
      { status: targetLoaded.status, headers: NO_STORE },
    );
  }

  const comparison = compareRunReports(baseLoaded.report, targetLoaded.report);
  return NextResponse.json({ comparison }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }

  const pair = validatePair(body.baseRunId ?? body.base, body.targetRunId ?? body.target);
  if (!pair.ok) {
    return NextResponse.json({ error: pair.error }, { status: 400, headers: NO_STORE });
  }

  const baseLoaded = loadOwnedReport(user, pair.baseId);
  if (!baseLoaded.ok) {
    return NextResponse.json({ error: baseLoaded.error }, { status: baseLoaded.status, headers: NO_STORE });
  }
  const targetLoaded = loadOwnedReport(user, pair.targetId);
  if (!targetLoaded.ok) {
    return NextResponse.json(
      { error: targetLoaded.error },
      { status: targetLoaded.status, headers: NO_STORE },
    );
  }

  const comparison = compareRunReports(baseLoaded.report, targetLoaded.report);

  if (body.remember === true) {
    const tags = sanitizeTags(body.tags);
    const stored = await writeMemory(user, { fact: comparison.digest, tags });
    recordAudit({
      user,
      action: "run.compare.remember",
      target: `${pair.baseId}..${pair.targetId}`,
      result: "success",
    });
    return NextResponse.json(
      { comparison, remembered: publicFact(stored) },
      { status: 201, headers: NO_STORE },
    );
  }

  return NextResponse.json({ comparison }, { headers: NO_STORE });
}
