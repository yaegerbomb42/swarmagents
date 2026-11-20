/**
 * The codebase strike API.
 *
 * POST /api/runtime/codebase/strike { repo?, path, action } -> starts (or
 * queues) one scoped run against a hotspot -> { ok, runId, queued,
 * sliceTokenEstimate }
 *
 * `action` is one of "refactor" | "tests" | "explain". `path` must be a file
 * or a top-level module in the caller's own codebase map: anything else is
 * a 404 and can never escape the repository. The run is enqueued with the
 * same `getRuntimeManager().start(user, { prompt })` call the tasks route
 * uses, so the one-active-run-per-user queue semantics are identical — the
 * strike never reimplements queuing.
 *
 * For `action: "explain"` the architecture lens runs server-side first
 * (lib/codebase/strike-lens.ts): its diagram rides in the run's prompt and
 * in the response as `lens`. A lens failure never blocks the run — the
 * strike falls back to the old prompt wording.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { getVmManager, type VmManager } from "../../../../../lib/vm/manager";
import { resolveWorkspacePath, VmPathError } from "../../../../../lib/vm/files";
import { ensureCodebaseMap } from "../../../../../lib/codebase/store";
import { createVmScanner } from "../../../../../lib/codebase/vm-scanner";
import { createLocalScanner } from "../../../../../lib/codebase/local-scanner";
import {
  STRIKE_ACTIONS,
  buildDependencySlice,
  composeStrikePrompt,
  isStrikeAction,
  resolveSliceTarget,
  targetCoveragePct,
} from "../../../../../lib/codebase/slice";
import { runExplainLens } from "../../../../../lib/codebase/strike-lens";
import { getRuntimeManager } from "../../../../../lib/runtime/manager";
import type { CodebaseScanner } from "../../../../../lib/codebase/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Token budget for the dependency slice handed to the run. */
const STRIKE_SLICE_BUDGET = 4000;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

/**
 * Local development / e2e hook. When `SWARM_CODEBASE_LOCAL_ROOT` names a
 * checkout on the app server's own filesystem, the map is built from that
 * checkout with the same analyzer the VM runs. It is unset in production,
 * where the repository exists only inside the caller's VM.
 */
function localRoot(): string | null {
  const configured = process.env.SWARM_CODEBASE_LOCAL_ROOT?.trim();
  return configured ? path.resolve(configured) : null;
}

/** The scanner the route uses: the caller's VM, or a local checkout in dev. */
function scannerFor(vm: VmManager, local: string | null): CodebaseScanner {
  return local ? createLocalScanner() : createVmScanner(vm);
}

/**
 * The repository root the caller asked for (always inside the workspace).
 * In local mode the request is resolved against the configured checkout and
 * may never escape it.
 */
function repoRootFrom(raw: string | null, local: string | null): string {
  if (!local) return resolveWorkspacePath(raw ?? "");
  const requested = (raw ?? "").trim();
  if (!requested) return local;
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(local, requested);
  if (resolved === local || resolved.startsWith(`${local}${path.sep}`)) return resolved;
  throw new VmPathError("outside_workspace", "Path is outside the local codebase root.");
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  let body: { repo?: unknown; path?: unknown; action?: unknown } = {};
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  if (!isStrikeAction(body.action)) {
    return NextResponse.json(
      { error: `action must be one of: ${STRIKE_ACTIONS.join(", ")}.` },
      { status: 400 },
    );
  }
  const action = body.action;
  if (typeof body.path !== "string" || !body.path.trim()) {
    return NextResponse.json({ error: "path is required." }, { status: 400 });
  }

  const local = localRoot();
  const vm = getVmManager();
  const scanner = scannerFor(vm, local);

  let repoRoot: string;
  try {
    repoRoot = repoRootFrom(typeof body.repo === "string" ? body.repo : null, local);
  } catch (error) {
    const status = error instanceof VmPathError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status });
  }

  // The map is read back when it is current and rebuilt when HEAD moved,
  // exactly like GET /api/runtime/codebase.
  const map = await ensureCodebaseMap(user, scanner, { repoRoot });
  if (!map) {
    return NextResponse.json(
      { error: "No codebase map for this repository yet.", repoRoot },
      { status: 404 },
    );
  }

  // The path must name a file or a top-level module in the caller's own
  // map. Anything else — including a path that would escape the repo — is
  // a 404, never a run.
  const target = resolveSliceTarget(map, body.path);
  if (!target) {
    return NextResponse.json(
      { error: "Path is not a file or top-level module in this codebase map." },
      { status: 404 },
    );
  }

  const slice = buildDependencySlice(map, target.path, STRIKE_SLICE_BUDGET);
  const targetFile =
    target.kind === "file" ? map.files.find((file) => file.path === target.path) : undefined;

  // "explain" runs the architecture lens server-side over the slice before
  // the run starts. Best effort: a lens failure returns null and the strike
  // proceeds with the prompt telling the agent to run the lens itself.
  const lens = action === "explain" ? await runExplainLens(user, slice, map) : null;

  const prompt = composeStrikePrompt(action, slice, {
    ...(targetFile?.complexity !== undefined ? { complexity: targetFile.complexity } : {}),
    coveragePct:
      target.kind === "file" ? (targetFile?.coveragePct ?? null) : targetCoveragePct(map, target),
    ...(lens ? { lensFindings: lens.text } : {}),
  });

  const result = getRuntimeManager().start(user, { prompt });
  if (!result.accepted) {
    if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(
      { error: `Run queue is full (max ${result.limit ?? 3}). Wait for a run to finish.` },
      { status: 429 },
    );
  }
  const response = {
    ok: true,
    runId: result.runId,
    queued: result.queued,
    ...(result.queued && result.position !== undefined ? { position: result.position } : {}),
    sliceTokenEstimate: slice.tokenEstimate,
    ...(lens ? { lens } : {}),
  };
  return NextResponse.json(response, { status: result.queued ? 202 : 201 });
}
