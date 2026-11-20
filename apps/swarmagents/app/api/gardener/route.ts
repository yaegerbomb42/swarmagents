import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { resolveWorkspacePath, VmPathError } from "@/lib/vm/files";
import { getVmManager } from "@/lib/vm/manager";
import {
  clampElo,
  readUserGardener,
  removeProposal,
  setProposalStatus,
  unpinRepo,
  updateUserGardener,
} from "@/lib/gardener/store";
import { runAutopilotTick } from "@/lib/gardener/tick";
import { MAX_PINNED_REPOSITORIES, MAX_REPO_ROOT_LEN } from "@/lib/gardener/types";

export const dynamic = "force-dynamic";

/** Gardener state and proposals are per-user work in progress: never cache. */
const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { ...init, headers: NO_STORE });
}

function userId(req: NextRequest): string | null {
  return requestUser(req)?.id ?? null;
}

export async function GET(req: NextRequest) {
  const id = userId(req);
  if (!id) return json({ error: "unauthorized" }, { status: 401 });
  const vm = getVmManager();
  const state = readUserGardener(id);
  return json({
    ...state,
    idleMs: vm.idle.idleMs,
    idleForMs: vm.idleForMs(id),
    inWindow: vm.usersInPreHibernateWindow().includes(id),
  });
}

export async function POST(req: NextRequest) {
  const id = userId(req);
  if (!id) return json({ error: "unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const body = rawBody as {
    action?: unknown;
    enabled?: unknown;
    workerElo?: unknown;
    repoRoot?: unknown;
    proposalId?: unknown;
  };

  if (typeof body.action !== "string" || !body.action) {
    return json({ error: "action required" }, { status: 400 });
  }

  if (body.action === "setEnabled") {
    const state = updateUserGardener(id, (next) => {
      next.enabled = body.enabled === true;
    });
    return json(state);
  }
  if (body.action === "setElo") {
    if (body.workerElo === null || body.workerElo === undefined || typeof body.workerElo === "boolean") {
      return json({ error: "workerElo must be a finite number" }, { status: 400 });
    }
    const num = typeof body.workerElo === "number" ? body.workerElo : Number(body.workerElo);
    if (!Number.isFinite(num)) {
      return json({ error: "workerElo must be a finite number" }, { status: 400 });
    }
    const state = updateUserGardener(id, (next) => {
      next.workerElo = clampElo(num);
    });
    return json(state);
  }
  if (body.action === "pin") {
    const rawRepoRoot = typeof body.repoRoot === "string" ? body.repoRoot.trim() : "";
    if (!rawRepoRoot || rawRepoRoot.includes("\0")) {
      return json({ error: "repoRoot required" }, { status: 400 });
    }
    if (rawRepoRoot.length > MAX_REPO_ROOT_LEN) {
      return json({ error: `repoRoot exceeds maximum length of ${MAX_REPO_ROOT_LEN}` }, { status: 400 });
    }

    let repoRoot: string;
    try {
      repoRoot = resolveWorkspacePath(rawRepoRoot);
    } catch (err) {
      if (err instanceof VmPathError) {
        return json({ error: err.message }, { status: 400 });
      }
      return json({ error: "invalid repoRoot" }, { status: 400 });
    }

    const currentState = readUserGardener(id);
    const alreadyPinned = currentState.pinned.some((p) => p.repoRoot === repoRoot);
    if (!alreadyPinned && currentState.pinned.length >= MAX_PINNED_REPOSITORIES) {
      return json(
        { error: `maximum number of pinned repositories (${MAX_PINNED_REPOSITORIES}) reached` },
        { status: 400 },
      );
    }

    const state = updateUserGardener(id, (next) => {
      if (!next.pinned.some((p) => p.repoRoot === repoRoot)) {
        if (next.pinned.length >= MAX_PINNED_REPOSITORIES) {
          return;
        }
        next.pinned.push({ repoRoot, pinnedAt: Date.now() });
      }
    });
    return json(state);
  }
  if (body.action === "unpin") {
    const rawRepoRoot = typeof body.repoRoot === "string" ? body.repoRoot.trim() : "";
    if (!rawRepoRoot || rawRepoRoot.includes("\0")) {
      return NextResponse.json({ error: "repoRoot required" }, { status: 400 });
    }
    if (rawRepoRoot.length > MAX_REPO_ROOT_LEN) {
      return NextResponse.json({ error: `repoRoot exceeds maximum length of ${MAX_REPO_ROOT_LEN}` }, { status: 400 });
    }

    let repoRoot: string;
    try {
      repoRoot = resolveWorkspacePath(rawRepoRoot);
    } catch (err) {
      if (err instanceof VmPathError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      return NextResponse.json({ error: "invalid repoRoot" }, { status: 400 });
    }

    // Unpinning is a lifecycle step, not an update: nothing pinned means 404.
    if (!unpinRepo(id, repoRoot)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(readUserGardener(id));
  }
  if (body.action === "removeProposal") {
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    if (!proposalId) return NextResponse.json({ error: "proposalId required" }, { status: 400 });
    if (!removeProposal(id, proposalId)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(readUserGardener(id));
  }
  if (body.action === "approve" || body.action === "dismiss") {
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    if (!proposalId) return json({ error: "proposalId required" }, { status: 400 });
    const row = setProposalStatus(id, proposalId, body.action === "approve" ? "approved" : "dismissed");
    if (!row) return json({ error: "not found" }, { status: 404 });
    return json(row);
  }
  if (body.action === "tick") {
    const result = await runAutopilotTick(id, getVmManager());
    return json({ result, state: readUserGardener(id) });
  }
  return json({ error: "unknown action" }, { status: 400 });
}
