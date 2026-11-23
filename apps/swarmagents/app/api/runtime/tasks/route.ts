/**
 * Runtime tasks control plane.
 *
 * POST  {prompt, sessionId?}        -> starts or queues a run -> {runId, queued, position?, capacity?}
 * POST  {action:"wipe_vm"}          -> resets the user's VM
 * POST  {action:"new_thread"}       -> cancels active/queued runs and clears the persisted session
 * GET                               -> {runs: RunSummary[]} for the caller
 * DELETE ?runId=<id> (or omit)      -> cancels the active/requested run or removes a queued prompt
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 * Events for a run stream at /api/runtime/stream/[runId]. At most one run is
 * active per user: a new prompt while one is running is queued (up to
 * SWARM_MAX_QUEUED, default 3) and starts when the active run finishes.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getProject, isProjectId, updateProject } from "../../../../lib/projects/store";
import { buildProjectContext } from "../../../../lib/projects/summary";
import { getRuntimeManager } from "../../../../lib/runtime/manager";
import { parseComputeTarget, type ComputeTarget } from "../../../../lib/computers";
import { getRemoteRunManager } from "../../../../lib/computers/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 256 * 1024;
const MAX_PROMPT_LEN = 200_000;
/** Agent card text cap: the card is the role, and it is sent on every task. */
const MAX_AGENT_CARD_LEN = 4000;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  // Cloud runs come from the runtime manager; BYOC jobs live in the remote
  // control plane. Both are per-account, so the client can merge them into one
  // thread list.
  return NextResponse.json({
    runs: [...getRuntimeManager().list(user), ...getRemoteRunManager().list(user)],
  });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400 });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  // Factory reset of the user's VM (the UI sends {action:"wipe_vm"}).
  if (body.action === "wipe_vm" || body.reset === true) {
    await getRuntimeManager().resetVm(user);
    return NextResponse.json({ ok: true, status: "reset" });
  }

  if (body.action === "new_thread") {
    await getRuntimeManager().newThread(user);
    getRemoteRunManager().cancel(user);
    return NextResponse.json({ ok: true, status: "new_thread" });
  }

  // Pause/resume a BYOC run. A paused run keeps its prompt; resume requeues it
  // on the same computer once that computer is online again.
  if (body.action === "pause" || body.action === "resume") {
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!runId) return NextResponse.json({ error: "runId is required." }, { status: 400 });
    const remote = getRemoteRunManager();
    if (body.action === "pause") {
      const ok = remote.pauseRun(user, runId, "user");
      if (!ok) {
        return NextResponse.json({ error: "Run is not active or not yours." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, runId });
    }
    const resumed = remote.resume(user, runId);
    if (!resumed.runId) {
      return NextResponse.json({ error: resumed.error ?? "Could not resume." }, { status: resumed.status ?? 409 });
    }
    return NextResponse.json({ ok: true, runId: resumed.runId, resumedFrom: runId }, { status: 202 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return NextResponse.json({ error: "prompt too long." }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  const agentCard =
    typeof body.agentCard === "string" && body.agentCard.trim()
      ? body.agentCard.trim().slice(0, MAX_AGENT_CARD_LEN)
      : undefined;
  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  // g9 full-auto: the synchronous approval hook auto-approves in-VM asks while
  // still denying hard-deny and irreversible-external actions. The minimal
  // main page sends `autoApprove` for the same mode.
  const autoApprove = body.autoApprove === true;
  const fullAuto = body.fullAuto === true || autoApprove;

  // Starting role + the user's explicit role pre-grants for this run. The
  // manager resolves both against the caller's own catalog; a pre-grant the
  // user does not own is ignored, and an unknown starting role is rejected.
  const roleId =
    typeof body.roleId === "string" && body.roleId.trim() ? body.roleId.trim().slice(0, 64) : undefined;
  const grantedRoleIds = Array.isArray(body.grantedRoleIds)
    ? body.grantedRoleIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim().slice(0, 64))
        .filter((id) => id.length > 0)
        .slice(0, 50)
    : undefined;

  // Project continuity (g5): the project must belong to this caller. The
  // manager injects the "Previously…" digest only when this run starts a fresh
  // thread; continuing a session already carries the context in its history.
  const rawProjectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  let projectId: string | undefined;
  let projectContext: string | undefined;
  if (rawProjectId) {
    if (!isProjectId(rawProjectId)) {
      return NextResponse.json({ error: "Unknown project." }, { status: 404 });
    }
    const project = getProject(user, rawProjectId);
    if (!project) {
      return NextResponse.json({ error: "Unknown project." }, { status: 404 });
    }
    projectId = project.id;
    projectContext = buildProjectContext(project);
  }

  // Compute target: the request wins, then the project's remembered choice,
  // then the cloud pool. A BYOC target is dispatched to the node on that
  // computer; the server only queues it and streams the node's events.
  const rawTarget =
    typeof body.computeTarget === "string" && body.computeTarget.trim()
      ? body.computeTarget.trim()
      : projectId
        ? getProject(user, projectId)?.computeTarget
        : undefined;
  let computeTarget: ComputeTarget = { kind: "cloud" };
  if (rawTarget !== undefined) {
    const parsed = parseComputeTarget(rawTarget);
    if (!parsed) {
      return NextResponse.json({ error: "Unknown compute target." }, { status: 400 });
    }
    computeTarget = parsed;
  }
  if (projectId && computeTarget.kind === "computer" && rawTarget !== undefined) {
    // Remember the choice for the project so the next composer defaults to it.
    try {
      updateProject(user, projectId, { computeTarget: rawTarget });
    } catch {
      // A project deleted mid-request must not block the run.
    }
  }

  if (computeTarget.kind === "computer") {
    const started = getRemoteRunManager().start(user, {
      prompt,
      computerId: computeTarget.computerId,
      ...(sessionId ? { sessionId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentCard ? { agentCard } : {}),
    });
    if (!started.accepted) {
      return NextResponse.json({ error: started.error }, { status: started.status ?? 400 });
    }
    return NextResponse.json(
      {
        runId: started.runId,
        queued: true,
        compute: { kind: "computer", computerId: computeTarget.computerId },
      },
      { status: 202 },
    );
  }

  const result = getRuntimeManager().start(user, {
    prompt,
    agentCard,
    sessionId,
    model,
    ...(roleId ? { roleId } : {}),
    ...(grantedRoleIds ? { grantedRoleIds } : {}),
    projectId,
    projectContext,
    computeTarget: "cloud",
    fullAuto,
  });
  if (!result.accepted) {
    if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(
      { error: `Run queue is full (max ${result.limit ?? 3}). Wait for a run to finish.` },
      { status: 429 },
    );
  }
  if (result.queued) {
    return NextResponse.json(
      {
        runId: result.runId,
        queued: true,
        position: result.position,
        // Present when the run is waiting for a global VM slot
        // (SWARM_MAX_CONCURRENT_VMS) rather than for the caller's own run.
        ...(result.capacity ? { capacity: result.capacity } : {}),
      },
      { status: 202 },
    );
  }
  return NextResponse.json({ runId: result.runId }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  const runId = new URL(req.url).searchParams.get("runId") ?? undefined;

  // Without an explicit runId, cancelling would kill both the user's active
  // cloud run and their active paired-computer run at the same time. When both
  // runtimes have live work, require the caller to pick one instead.
  if (runId === undefined) {
    const cloudHasActive = getRuntimeManager()
      .list(user)
      .some((r) => r.status === "running" || r.status === "queued");
    // The remote manager's list only returns live runs (queued/running/paused).
    const remoteHasActive = getRemoteRunManager().list(user).length > 0;
    if (cloudHasActive && remoteHasActive) {
      return NextResponse.json(
        {
          error:
            "runId is required when both a cloud run and a paired-computer run are active.",
        },
        { status: 400 },
      );
    }
  }

  const cloud = getRuntimeManager().cancel(user, runId);
  const remote = getRemoteRunManager().cancel(user, runId);
  if (!cloud.ok && !remote.ok) {
    return NextResponse.json(
      { error: runId ? "Run not found or not active." : "No active run to cancel." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, runId: cloud.runId ?? remote.runId });
}
