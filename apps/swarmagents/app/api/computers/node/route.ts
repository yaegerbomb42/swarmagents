/**
 * Node control channel for a paired computer.
 *
 * The node authenticates with its per-computer bearer token (returned once by
 * /api/computers/pair) plus its computer id. Every action resolves the token to
 * the owning account first, so a node can only ever touch its own work.
 *
 * POST { action: "heartbeat", machine? }        -> { ok, computer }
 * POST { action: "claim" }                     -> { job } | { job: null }
 * POST { action: "event", runId, event }       -> { ok } (409 when rejected)
 * POST { action: "events", events: [...] }     -> { ok, accepted, rejected } (batch, max 64)
 * POST { action: "complete", runId, result }   -> { ok } (409 when rejected)
 *
 * This path is public in the middleware allow-list (the bearer token is the
 * credential); it never reads or trusts x-swarm-user.
 */

import { NextResponse, type NextRequest } from "next/server";
import { recordHeartbeat } from "../../../../lib/computers";
import { computerAuth, nodeTokenFromRequest } from "../../../../lib/computers/node-token";
import { getRemoteRunManager } from "../../../../lib/computers/remote";
import { readJsonObject } from "../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_BODY_SIZE = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function computerId(req: NextRequest, body: Record<string, unknown>): unknown {
  return req.headers.get("x-computer-id") ?? body.computerId;
}

export async function POST(req: NextRequest) {
  // Bounded, streaming body read: an oversized body is rejected with 413
  // before it is buffered; a malformed body or a non-object stays a 400.
  const parsed = await readJsonObject(req, MAX_BODY_SIZE);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  const id = computerId(req, body);
  const token = nodeTokenFromRequest(req);
  if (!token) {
    return NextResponse.json({ error: "Unknown or revoked computer." }, { status: 401, headers: NO_STORE });
  }
  const auth = computerAuth.authenticate(id, token);
  if (!auth) {
    return NextResponse.json({ error: "Unknown or revoked computer." }, { status: 401, headers: NO_STORE });
  }

  const manager = getRemoteRunManager();
  const action = body.action;

  if (action === "heartbeat") {
    const machine = isRecord(body.machine) ? body.machine : undefined;
    const refreshed = recordHeartbeat(auth.computer.id, token, machine);
    if (!refreshed) {
      return NextResponse.json({ error: "Unknown or revoked computer." }, { status: 401, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, computer: refreshed.computer }, { headers: NO_STORE });
  }

  if (action === "claim") {
    return NextResponse.json({ job: manager.claim(auth.userId, auth.computer.id)?.job ?? null }, { headers: NO_STORE });
  }

  if (action === "event") {
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!runId) {
      return NextResponse.json({ error: "runId is required." }, { status: 400, headers: NO_STORE });
    }
    const ok = manager.publishEvent(auth.userId, auth.computer.id, runId, body.event);
    if (!ok) {
      return NextResponse.json(
        { error: "Run is not running, not yours, or the event is invalid." },
        { status: 409, headers: NO_STORE },
      );
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  if (action === "events") {
    const entries = Array.isArray(body.events) ? body.events : [];
    const MAX_BATCH = 64;
    if (entries.length > MAX_BATCH) {
      return NextResponse.json({ error: `At most ${MAX_BATCH} events per batch.` }, { status: 400, headers: NO_STORE });
    }
    // Per-entry checks so one bad entry does not lose the rest of the batch.
    let accepted = 0;
    let rejected = 0;
    for (const entry of entries) {
      if (!isRecord(entry)) {
        rejected++;
        continue;
      }
      const runId = typeof entry.runId === "string" ? entry.runId : "";
      if (!runId) {
        rejected++;
        continue;
      }
      const ok = manager.publishEvent(auth.userId, auth.computer.id, runId, entry.event);
      ok ? accepted++ : rejected++;
    }
    return NextResponse.json({ ok: true, accepted, rejected }, { headers: NO_STORE });
  }

  if (action === "complete") {
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!runId) {
      return NextResponse.json({ error: "runId is required." }, { status: 400, headers: NO_STORE });
    }
    const result = isRecord(body.result) ? body.result : {};
    const ok = manager.complete(auth.userId, auth.computer.id, runId, result);
    if (!ok) {
      return NextResponse.json(
        { error: "Run is not live or does not belong to this computer." },
        { status: 409, headers: NO_STORE },
      );
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400, headers: NO_STORE });
}
