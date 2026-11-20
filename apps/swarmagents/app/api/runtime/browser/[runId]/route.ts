/**
 * Browser control plane for a run.
 *
 * GET  /api/runtime/browser/[runId]/frame  -> latest JPEG frame (image/jpeg)
 * POST /api/runtime/browser/[runId]        -> {url} (navigate) | {action:"screenshot"}
 *
 * Both are gated on the run being the caller's *active* run and on the URL
 * policy (lib/browser/policy.ts): file:// and private / loopback / link-local
 * destinations are refused with a 400 before Chromium loads anything. Frames
 * are also published as `browser.frame` events on the run's SSE stream (the
 * UI reacts to those); this route serves the actual JPEG bytes.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../lib/telemetry/paths";
import { getRuntimeManager } from "../../../../../lib/runtime/manager";
import { getBrowserManager } from "../../../../../lib/browser/manager";
import { isDesktopModeEnabled } from "../../../../../lib/vm/desktop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;
const MAX_URL_LEN = 8192;

/** In desktop mode the agent drives the on-screen browser; the headless frame
 * path is retired (the UI watches the VNC view instead). */
function desktopModeResponse(): Response {
  return NextResponse.json(
    { error: "Desktop mode: the agent drives the on-screen browser; headless browser control is disabled." },
    { status: 409 },
  );
}

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function activeRun(req: NextRequest, runId: string): Promise<{ user: string } | Response> {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (!RUN_ID_RE.test(runId)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  if (!getRuntimeManager().isActiveRun(user, runId)) {
    return NextResponse.json({ error: "Run not found or not active." }, { status: 404 });
  }
  return { user };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  if (isDesktopModeEnabled()) return desktopModeResponse();
  const { runId } = await ctx.params;
  const gate = await activeRun(req, runId);
  if (gate instanceof Response) return gate;

  const frame = await getBrowserManager().getFrame(runId);
  if (!frame) {
    return NextResponse.json({ error: "No frame captured yet." }, { status: 404 });
  }
  const bytes = Uint8Array.from(frame.jpeg);
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
      "Content-Length": String(bytes.byteLength),
    },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  if (isDesktopModeEnabled()) return desktopModeResponse();
  const { runId } = await ctx.params;
  const gate = await activeRun(req, runId);
  if (gate instanceof Response) return gate;

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

  if (body.action === "screenshot") {
    const result = await getBrowserManager().screenshot(runId);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }
    return NextResponse.json({ ok: true, frameId: result.frameId, width: result.width, height: result.height });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url || url.length > MAX_URL_LEN) {
    return NextResponse.json({ error: "url is required." }, { status: 400 });
  }

  const result = await getBrowserManager().navigate(runId, url);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, url: result.url, title: result.title });
}
