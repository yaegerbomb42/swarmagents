/**
 * Team Mode control plane.
 *
 * POST {prompt, agentCard?, settings?} → start a team run → {runId}
 * GET                                   → {run, runs} for the caller
 * DELETE ?runId=<id>                    → cancel a team run
 *
 * Auth is the same per-account header the other api/ routes use (set by
 * middleware, see lib/auth). A team run streams on the normal telemetry
 * stream: /api/runtime/stream/<runId>.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { isComputerId } from "@/lib/computers";
import { getTeamManager } from "@/lib/team/manager";
import { DEFAULT_TEAM_SETTINGS, resolveTeamSettings, type TeamSettings } from "@/lib/team/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 256 * 1024;
const MAX_PROMPT_LEN = 200_000;
const MAX_AGENT_CARD_LEN = 4000;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const manager = getTeamManager();
  return NextResponse.json({ run: manager.get(user) ?? null, runs: manager.list(user) });
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
  if (text.length > MAX_BODY_SIZE) return NextResponse.json({ error: "Request body too large." }, { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "prompt is required." }, { status: 400 });
  if (prompt.length > MAX_PROMPT_LEN) return NextResponse.json({ error: "prompt too long." }, { status: 400 });

  const agentCard =
    typeof record.agentCard === "string" && record.agentCard.trim()
      ? record.agentCard.trim().slice(0, MAX_AGENT_CARD_LEN)
      : undefined;
  const settings =
    typeof record.settings === "object" && record.settings !== null
      ? resolveTeamSettings(record.settings as Partial<TeamSettings>)
      : { ...DEFAULT_TEAM_SETTINGS };
  // Roles the user pre-granted for every lane. Unknown ids are dropped by the
  // manager's policy builder, so a client cannot grant a role it does not own.
  const grantedRoleIds = Array.isArray(record.grantedRoleIds)
    ? record.grantedRoleIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim().slice(0, 64))
        .filter((id) => id.length > 0)
        .slice(0, 50)
    : undefined;

  const byocComputerId =
    typeof record.byocComputerId === "string" && isComputerId(record.byocComputerId.trim())
      ? record.byocComputerId.trim().toLowerCase()
      : undefined;

  const result = getTeamManager().start(user, {
    prompt,
    ...(agentCard ? { agentCard } : {}),
    settings,
    ...(grantedRoleIds ? { grantedRoleIds } : {}),
    ...(byocComputerId ? { byocComputerId } : {}),
  });
  if (!result.accepted) {
    return NextResponse.json({ error: result.error ?? "Could not start the team run." }, { status: 409 });
  }
  return NextResponse.json({ runId: result.runId }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const runId = new URL(req.url).searchParams.get("runId") ?? undefined;
  const result = getTeamManager().cancel(user, runId);
  if (!result.ok) return NextResponse.json({ error: "No team run to cancel." }, { status: 404 });
  return NextResponse.json({ ok: true, runId: result.runId });
}