/**
 * Start a run from a template.
 *
 * POST /api/templates/run  {templateId, values}  -> {runId, queued, position}
 *
 * The client sends only a template id and the user's answers. The prompt is
 * assembled here, on the server, from the template catalog — so the prompt
 * the agent receives is always the written one, and the role that runs it is
 * the template's recommended role. Nothing per-account is stored: the catalog
 * is static and the run belongs to the caller.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getRuntimeManager } from "../../../../lib/runtime/manager";
import { findTemplate, renderPrompt } from "../../../../lib/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;
const MAX_VALUES = 12;
/** Per-answer cap: a template answer is a short piece of text, not a file. */
const MAX_VALUE_LEN = 2000;
const MAX_PROMPT_LEN = 20_000;
/** Agent card cap: the card is the role, and it is sent on every task. */
const MAX_AGENT_CARD_LEN = 4000;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

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

  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  if (!templateId) {
    return NextResponse.json({ error: "templateId is required." }, { status: 400 });
  }
  const template = findTemplate(templateId);
  if (!template) {
    return NextResponse.json({ error: "Unknown template." }, { status: 404 });
  }

  // Only the template's own fields are accepted, and only as strings.
  const rawValues = isRecord(body.values) ? body.values : {};
  const values: Record<string, string> = {};
  for (const field of template.fields) {
    const value = rawValues[field.name];
    if (typeof value === "string") {
      values[field.name] = value.slice(0, MAX_VALUE_LEN);
    }
  }

  const prompt = renderPrompt(template, values).trim();
  if (!prompt) {
    return NextResponse.json({ error: "The template produced an empty prompt." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return NextResponse.json({ error: "prompt too long" }, { status: 400 });
  }

  // The user's Agent Card still rides along: the template chooses the role,
  // the card says who the agent is.
  const agentCard =
    typeof body.agentCard === "string" && body.agentCard.trim()
      ? body.agentCard.trim().slice(0, MAX_AGENT_CARD_LEN)
      : undefined;

  // The minimal main page runs in auto-approve mode; the manager's full-auto
  // policy still denies host targets (VM-only) and irreversible external work.
  const autoApprove = body.autoApprove === true;
  const result = getRuntimeManager().start(user, { prompt, roleId: template.role, agentCard, fullAuto: autoApprove });
  if (!result.accepted) {
    return NextResponse.json(
      { error: result.error ?? "Could not start the run." },
      { status: result.error ? 400 : 429 },
    );
  }
  // The rendered prompt comes back so the client can show exactly what the
  // agent was asked to do — there is only one rendering of it, the server's.
  if (result.queued) {
    return NextResponse.json(
      { runId: result.runId, queued: true, position: result.position, prompt },
      { status: 202 },
    );
  }
  return NextResponse.json({ runId: result.runId, prompt }, { status: 201 });
}
