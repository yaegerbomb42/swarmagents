/**
 * Which browser backend serves a run's Browser tab.
 *
 * GET /api/runtime/browser/[runId]/mode -> { mode: "host" | "vm" | "unavailable" }
 *
 * - "host": a host-side headless Chromium (SWARM_BROWSER_HOST=1 or the fake
 *   driver) — the historic behavior.
 * - "vm": the Browser tab mirrors the Chromium the agent drives inside its
 *   Linux desktop VM (CDP).
 * - "unavailable": the fake driver with no host browser — the browser lives
 *   inside the user's computer and the tab says so (see BROWSER_IN_VM_MESSAGE).
 *
 * Gated on run ownership like the frame route, so a user can only learn the
 * mode of their own runs.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../lib/telemetry/paths";
import { getRuntimeManager } from "../../../../../../lib/runtime/manager";
import { getBrowserManager } from "../../../../../../lib/browser/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { runId } = await ctx.params;
  if (!RUN_ID_RE.test(runId)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  if (!getRuntimeManager().ownsRun(user, runId)) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json({ mode: getBrowserManager().getMode() });
}
