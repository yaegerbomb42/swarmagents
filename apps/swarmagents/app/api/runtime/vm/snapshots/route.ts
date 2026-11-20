/**
 * VM checkpoints (snapshots).
 *
 * GET  -> {snapshots: VmSnapshot[]} newest first
 * POST {action:"create", label} -> creates a checkpoint -> 201 {ok, snapshot}
 * POST {action:"restore", label} -> rolls the VM back -> 200 {ok, label}
 * POST {action:"delete", label} -> deletes the checkpoint (image + workspace
 *   backup volume) -> 200 {ok, label}; 404 when no such checkpoint exists.
 *
 * POST without an action defaults to create, so `{label}` is also accepted.
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { getVmManager } from "../../../../../lib/vm/manager";
import { validateSnapshotLabel } from "../../../../../lib/vm/docker-driver";
import { recordAudit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;

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

function invalidLabel(err: unknown) {
  const message = err instanceof Error ? err.message : "Invalid snapshot label.";
  return NextResponse.json({ error: message }, { status: 400 });
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  try {
    const snapshots = await getVmManager().listSnapshots(user);
    return NextResponse.json({ snapshots });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not list snapshots.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
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

  // Both {action,label} and the shorthand {create|restore|delete:"label"} work.
  let action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  let rawLabel: unknown = body.label;
  if (!action && typeof body.create === "string") {
    action = "create";
    rawLabel = body.create;
  }
  if (!action && typeof body.restore === "string") {
    action = "restore";
    rawLabel = body.restore;
  }
  if (!action && typeof body.delete === "string") {
    action = "delete";
    rawLabel = body.delete;
  }
  if (!action) action = "create";
  if (action !== "create" && action !== "snapshot" && action !== "restore" && action !== "delete") {
    return NextResponse.json({ error: "action must be create, restore, or delete." }, { status: 400 });
  }

  if (typeof rawLabel !== "string" || !rawLabel.trim()) {
    return NextResponse.json({ error: "label is required." }, { status: 400 });
  }
  const label = rawLabel.trim();
  try {
    validateSnapshotLabel(label);
  } catch (err) {
    return invalidLabel(err);
  }

  const vm = getVmManager();

  if (action === "delete") {
    try {
      await vm.deleteSnapshot(user, label);
      recordAudit({ user, action: "snapshot.delete", target: label, result: "success" });
      return NextResponse.json({ ok: true, label });
    } catch (err) {
      recordAudit({ user, action: "snapshot.delete", target: label, result: "failure" });
      if (isNotFound(err)) {
        return NextResponse.json({ error: err instanceof Error ? err.message : "Snapshot not found." }, { status: 404 });
      }
      const message = err instanceof Error ? err.message : "Could not delete snapshot.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (action === "restore") {
    try {
      await vm.restore(user, label);
      recordAudit({ user, action: "snapshot.restore", target: label, result: "success" });
      return NextResponse.json({ ok: true, label });
    } catch (err) {
      recordAudit({ user, action: "snapshot.restore", target: label, result: "failure" });
      if (isNotFound(err)) {
        return NextResponse.json({ error: err instanceof Error ? err.message : "Snapshot not found." }, { status: 404 });
      }
      const message = err instanceof Error ? err.message : "Could not restore snapshot.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  try {
    const snapshot = await vm.snapshot(user, label);
    recordAudit({ user, action: "snapshot.create", target: label, result: "success" });
    return NextResponse.json({ ok: true, snapshot }, { status: 201 });
  } catch (err) {
    recordAudit({ user, action: "snapshot.create", target: label, result: "failure" });
    const message = err instanceof Error ? err.message : "Could not create snapshot.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
