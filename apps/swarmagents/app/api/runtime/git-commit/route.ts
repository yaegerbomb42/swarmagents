/**
 * POST /api/runtime/git-commit — smart-commit the caller's VM workspace.
 *
 * Stages tracked changes, asks the caller's own provider for a one-line
 * conventional-commit message, and commits (lib/harness/git-committer.ts).
 * The body is optional-field JSON: `{ autoStageAll?, maxDiffChars? }` (send
 * `{}` for defaults). The reply is always the committer's result object —
 * `{ success, commitMessage, filesCommitted, output }` — with `success:
 * false` for domain outcomes like "nothing staged" or "no provider
 * configured", which are not HTTP errors.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { USER_HEADER } from "@/lib/auth";
import { smartCommit, smartCommitDepsFor, type SmartCommitOptions } from "@/lib/harness/git-committer";
import { noStoreJson, noStoreRouteError, readJsonObject } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DIFF_CHARS_LIMIT = 20_000;

// One smart commit per user at a time: two concurrent calls would race on
// the workspace's git index (one fails with an index-lock error mid-flight).
const inFlight = new Set<string>();

function unauthorized() {
  return noStoreJson({ error: "Sign in required." }, { status: 401 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Middleware clears any client-supplied value and sets the authenticated id.
  const userId = request.headers.get(USER_HEADER);
  if (!userId) return unauthorized();

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const input = read.value;

  const options: SmartCommitOptions = {};
  if ("autoStageAll" in input) {
    if (typeof input.autoStageAll !== "boolean") {
      return noStoreJson({ error: "autoStageAll must be a boolean." }, { status: 400 });
    }
    options.autoStageAll = input.autoStageAll;
  }
  if ("maxDiffChars" in input) {
    const value = input.maxDiffChars;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > MAX_DIFF_CHARS_LIMIT
    ) {
      return noStoreJson(
        { error: `maxDiffChars must be a positive integer up to ${MAX_DIFF_CHARS_LIMIT}.` },
        { status: 400 },
      );
    }
    options.maxDiffChars = value;
  }

  if (inFlight.has(userId)) {
    return noStoreJson(
      { error: "A smart commit is already running for this workspace." },
      { status: 409 },
    );
  }
  inFlight.add(userId);
  try {
    const result = await smartCommit(userId, smartCommitDepsFor(), options);
    recordAudit({
      user: userId,
      action: "git.commit",
      target: userId,
      result: result.success ? "success" : "failure",
    });
    return noStoreJson(result);
  } catch (err) {
    return noStoreRouteError(err, "Smart commit failed.");
  } finally {
    inFlight.delete(userId);
  }
}
