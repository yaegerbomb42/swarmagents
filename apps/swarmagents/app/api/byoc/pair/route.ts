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
 */

import { type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { noStoreJson } from "../../../../lib/http";
import { getByocHub } from "../../../../lib/byoc/hub";
import { getByocTokenStore } from "../../../../lib/byoc/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      const body = JSON.parse(text) as { name?: unknown };
      if (typeof body.name === "string") name = body.name.trim().slice(0, 64);
    }
  } catch {
    // An empty or malformed body simply means "no name".
  }

  const store = getByocTokenStore();
  const { code, expiresAt } = store.createPairingCode(user);
  return noStoreJson(
    {
      code,
      expiresAt,
      name,
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
  return noStoreJson({ ok: true, deviceId }, { status: 200 });
}
