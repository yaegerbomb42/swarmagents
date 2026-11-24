import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { resolveWorkspacePath, VmPathError } from "@/lib/vm/files";
import { getVmManager } from "@/lib/vm/manager";
import {
  readUserGardener,
  removeProposal,
  setProposalStatus,
  unpinRepo,
  updateUserGardener,
} from "@/lib/gardener/store";
import { runAutopilotTick } from "@/lib/gardener/tick";
import { MAX_PINNED_REPOSITORIES, MAX_REPO_ROOT_LEN } from "@/lib/gardener/types";
import { recordAudit } from "@/lib/audit";
import { TokenBucket } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Gardener state and proposals are per-user work in progress: never cache. */
const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { ...init, headers: NO_STORE });
}

// Tick rate limiter: 1 tick per 5 seconds per user (capacity 1, window 5,000ms)
const tickRateLimiter = new TokenBucket(1, 5_000);

// In-process concurrency guard for tick per user
const activeUserTicks = new Set<string>();

function userId(req: NextRequest): string | null {
  return requestUser(req)?.id ?? null;
}

/** Validate a pin/unpin path once: both branches need the same 400 replies. */
function repoRootFrom(raw: unknown): { ok: true; path: string } | { ok: false; response: NextResponse } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.includes("\0")) {
    return { ok: false, response: json({ error: "repoRoot required" }, { status: 400 }) };
  }
  if (value.length > MAX_REPO_ROOT_LEN) {
    return { ok: false, response: json({ error: `repoRoot exceeds maximum length of ${MAX_REPO_ROOT_LEN}` }, { status: 400 }) };
  }
  try {
    return { ok: true, path: resolveWorkspacePath(value) };
  } catch (err) {
    if (err instanceof VmPathError) {
      return { ok: false, response: json({ error: err.message }, { status: 400 }) };
    }
    return { ok: false, response: json({ error: "invalid repoRoot" }, { status: 400 }) };
  }
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
    maxDifficulty?: unknown;
    repoRoot?: unknown;
    proposalId?: unknown;
  };

  if (typeof body.action !== "string" || !body.action) {
    return json({ error: "action required" }, { status: 400 });
  }

  if (body.action === "setEnabled") {
    if (typeof body.enabled !== "boolean") {
      return json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    const enabled = body.enabled;
    const state = updateUserGardener(id, (next) => {
      next.enabled = enabled;
    });
    recordAudit({
      user: id,
      action: "gardener.autopilot",
      target: enabled ? "enabled" : "disabled",
      result: "success",
    });
    return json(state);
  }
  if (body.action === "setDifficulty") {
    if (body.maxDifficulty !== "easy" && body.maxDifficulty !== "medium" && body.maxDifficulty !== "hard") {
      return json({ error: "maxDifficulty must be one of easy, medium, hard" }, { status: 400 });
    }
    const state = updateUserGardener(id, (next) => {
      next.maxDifficulty = body.maxDifficulty as "easy" | "medium" | "hard";
    });
    return json(state);
  }
  if (body.action === "pin") {
    const root = repoRootFrom(body.repoRoot);
    if (!root.ok) return root.response;
    const repoRoot = root.path;

    let limitReached = false;
    const state = updateUserGardener(id, (next) => {
      const alreadyPinned = next.pinned.some((p) => p.repoRoot === repoRoot);
      if (!alreadyPinned) {
        if (next.pinned.length >= MAX_PINNED_REPOSITORIES) {
          limitReached = true;
          return;
        }
        next.pinned.push({ repoRoot, pinnedAt: Date.now() });
      }
    });

    if (limitReached) {
      return json(
        { error: `maximum number of pinned repositories (${MAX_PINNED_REPOSITORIES}) reached` },
        { status: 400 },
      );
    }
    return json(state);
  }
  if (body.action === "unpin") {
    const root = repoRootFrom(body.repoRoot);
    if (!root.ok) return root.response;
    const repoRoot = root.path;

    // Unpinning is a lifecycle step, not an update: nothing pinned means 404.
    if (!unpinRepo(id, repoRoot)) return json({ error: "not found" }, { status: 404 });
    return json(readUserGardener(id));
  }
  if (body.action === "removeProposal") {
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    if (!proposalId) return json({ error: "proposalId required" }, { status: 400 });
    if (!removeProposal(id, proposalId)) return json({ error: "not found" }, { status: 404 });
    return json(readUserGardener(id));
  }
  if (body.action === "approve" || body.action === "dismiss") {
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    if (!proposalId) return json({ error: "proposalId required" }, { status: 400 });
    const row = setProposalStatus(id, proposalId, body.action === "approve" ? "approved" : "dismissed");
    if (!row) return json({ error: "not found" }, { status: 404 });
    return json(row);
  }
  if (body.action === "tick") {
    // Rate limit
    const rate = tickRateLimiter.consume(id);
    if (!rate.allowed) {
      return json({ error: "rate limit exceeded, please retry later" }, { status: 429 });
    }

    // Concurrency guard
    if (activeUserTicks.has(id)) {
      return json({ error: "a tick is already in progress for this account" }, { status: 409 });
    }

    activeUserTicks.add(id);
    try {
      const result = await runAutopilotTick(id, getVmManager());
      return json({ result, state: readUserGardener(id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "gardener tick failed";
      return json({ error: message }, { status: 500 });
    } finally {
      activeUserTicks.delete(id);
    }
  }
  return json({ error: "unknown action" }, { status: 400 });
}
