/**
 * Exchange a share-room token for a short-lived, single-use WebSocket ticket.
 *
 * POST /api/share/{token}/ws-ticket -> { ticket, expiresAt }
 *
 * Guests never put the long-lived share token in the WebSocket URL query
 * string; instead they exchange it here over HTTPS POST and dial
 * `/desktop/ws?mode=view&ticket=...`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { NO_STORE } from "@/lib/auth";
import { resolveRoom } from "@/lib/rooms/room";
import { issueWsTicket } from "@/lib/rooms/ws-ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const room = resolveRoom(token);
  if (!room) {
    return NextResponse.json({ error: "Share link not found." }, { status: 404, headers: NO_STORE });
  }

  const { ticket, expiresAt } = issueWsTicket(room.ownerId);
  return NextResponse.json({ ticket, expiresAt }, { headers: NO_STORE });
}
