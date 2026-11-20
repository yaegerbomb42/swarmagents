/**
 * Preview share links (F10).
 *
 * POST   /api/runtime/vm/preview/share {port} -> {share: {token, url, port, createdAt}}
 * DELETE /api/runtime/vm/preview/share?port=3000 -> {ok: true}
 * GET    /api/runtime/vm/preview/share -> {shares: [{port, url, createdAt}]}
 *
 * Mirrors the project share-link pattern (app/api/projects/[id]/share): the
 * token is the only credential for the public preview URL
 * `/preview/share/<token>/<port>/`. Only the owner can create, list, or
 * revoke shares for their VM; the port must currently be listening in the
 * owner's VM, so a share can never be minted for a port nothing serves.
 * Rotating a share for a port replaces its token — the old link 404s.
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { recordAudit } from "../../../../../../lib/audit";
import { getVmManager } from "../../../../../../lib/vm/manager";
import { isPreviewablePort } from "../../../../../../lib/preview/ports";
import {
  createPreviewShare,
  listPreviewShares,
  revokePreviewShare,
} from "../../../../../../lib/preview/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

function shareUrl(token: string, port: number): string {
  return `/preview/share/${token}/${port}/`;
}

function parsePortParam(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value)) return null;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

async function readPort(req: NextRequest): Promise<number | null> {
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as unknown;
      if (!body || typeof body !== "object") return null;
      return parsePortParam(
        typeof (body as Record<string, unknown>).port === "number"
          ? String((body as Record<string, unknown>).port)
          : null,
      );
    } catch {
      return null;
    }
  }
  return parsePortParam(req.nextUrl.searchParams.get("port"));
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const shares = listPreviewShares(user).map((share) => ({
    port: share.port,
    url: shareUrl(share.token, share.port),
    createdAt: share.createdAt,
  }));
  return NextResponse.json({ shares });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const port = await readPort(req);
  if (port === null) {
    return NextResponse.json({ error: "A valid port is required." }, { status: 400 });
  }
  // A share can only be minted for a port a process is actually listening
  // on in the owner's VM right now.
  let previewable = false;
  try {
    previewable = await isPreviewablePort(getVmManager(), user, port);
  } catch {
    previewable = false;
  }
  if (!previewable) {
    return NextResponse.json({ error: "No app is listening on that port." }, { status: 404 });
  }
  const share = createPreviewShare(user, port);
  recordAudit({ user, action: "preview.share.create", target: String(port), result: "success" });
  return NextResponse.json({
    share: {
      token: share.token,
      url: shareUrl(share.token, port),
      port,
      createdAt: share.createdAt,
    },
  });
}

export async function DELETE(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const port = await readPort(req);
  if (port === null) {
    return NextResponse.json({ error: "A valid port is required." }, { status: 400 });
  }
  const revoked = revokePreviewShare(user, port);
  if (revoked) {
    recordAudit({ user, action: "preview.share.revoke", target: String(port), result: "success" });
  }
  return NextResponse.json({ ok: true, revoked });
}
