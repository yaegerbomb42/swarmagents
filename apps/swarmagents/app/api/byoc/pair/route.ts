/**
 * BYOC pairing and node management.
 *
 *   POST   /api/byoc/pair          -> create a one-time pairing code
 *   GET    /api/byoc/pair          -> list the account's nodes (+ online state)
 *   DELETE /api/byoc/pair?deviceId -> revoke a node (kills its live session)
 *
 * Every route is scoped to the caller (the middleware-set x-swarm-user
 * header): a code belongs to the account that created it, and a device can
 * only be revoked by the account that owns it.
 *
 * Parallel BYOC surfaces: `/api/byoc/*` (lib/byoc) is the swarm-node path;
 * `/api/computers/*` (lib/computers) is the older computer-pairing path.
 * They share audit action names (`computer.pair` / `computer.revoke`) so the
 * audit trail stays one stream, but their stores are not unified yet — do
 * not assume a fix in one applies to the other.
 */

import { type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { noStoreJson } from "../../../../lib/http";
import { recordAudit } from "../../../../lib/audit";
import { getByocHub } from "../../../../lib/byoc/hub";
import { getByocTokenStore } from "../../../../lib/byoc/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pairing bodies are tiny; keep the cap tight. */
const MAX_PAIR_BODY_BYTES = 4 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return noStoreJson({ error: "Sign in required." }, { status: 401 });
}

/** Create a one-time pairing code for the caller. */
export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  let name = "";
  // Empty body is allowed (name optional). Non-empty must be valid JSON.
  let rawText = "";
  try {
    rawText = await req.text();
  } catch {
    return noStoreJson({ error: "Could not read the request body." }, { status: 400 });
  }
  if (Buffer.byteLength(rawText, "utf8") > MAX_PAIR_BODY_BYTES) {
    return noStoreJson({ error: "Request body is too large." }, { status: 413 });
  }
  if (rawText.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      return noStoreJson({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return noStoreJson({ error: "Body must be a JSON object." }, { status: 400 });
    }
    const rawName = (body as { name?: unknown }).name;
    if (typeof rawName === "string") name = rawName.trim().slice(0, 64);
  }

  const store = getByocTokenStore();
  const { code, expiresAt, name: storedName } = store.createPairingCode(user, { name });
  recordAudit({ user, action: "computer.pair", target: storedName || "pairing-code", result: "success" });
  return noStoreJson(
    {
      code,
      expiresAt,
      name: storedName,
      command: `npx swarm-node --pair ${code}`,
    },
    { status: 201 },
  );
}

/** List the caller's nodes and whether they are online. */
export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  const store = getByocTokenStore();
  const hub = getByocHub();
  const devices = store.listDevices(user).map((device) => {
    const session = hub.sessionForDevice(device.id);
    return {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt ?? null,
      revokedAt: device.revokedAt ?? null,
      revokedReason: device.revokedReason ?? null,
      online: Boolean(session),
      platform: session?.node.platform ?? null,
      arch: session?.node.arch ?? null,
      version: session?.node.version ?? null,
      hostMode: session?.node.hostMode ?? false,
      desktop: session?.node.desktop ?? false,
    };
  });

  return noStoreJson({ nodes: devices }, { status: 200 });
}

/** Revoke a node: its token stops working and its live session is killed. */
export async function DELETE(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  const deviceId = new URL(req.url).searchParams.get("deviceId") ?? "";
  if (!/^dev_[A-Za-z0-9_-]{1,64}$/.test(deviceId)) {
    return noStoreJson({ error: "Invalid deviceId." }, { status: 400 });
  }

  const store = getByocTokenStore();
  if (!store.getDevice(user, deviceId)) {
    return noStoreJson({ error: "No such node." }, { status: 404 });
  }

  const hub = getByocHub();
  hub.revokeDevice(user, deviceId, "revoked by the account owner");
  recordAudit({ user, action: "computer.revoke", target: deviceId, result: "success" });
  return noStoreJson({ ok: true, deviceId }, { status: 200 });
}
