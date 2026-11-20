import { NextResponse, type NextRequest } from "next/server";
import { createRouter, type CompleteRequest } from "@/lib/providers";
import { RouterError } from "@/lib/providers/errors";
import { routerProviders } from "@/lib/providers/store";
import { USER_HEADER } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 256 * 1024;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_LEN = 20_000;
const MAX_MAX_TOKENS = 4096;
const MAX_RACE = 8;

const VALID_TIERS = new Set(["fast", "balanced", "deep"]);

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const role = value.role;
  if (role !== "user" && role !== "assistant") return false;
  const content = value.content;
  return typeof content === "string" && content.trim().length > 0 && content.length <= MAX_MESSAGE_LEN;
}

function validate(body: unknown):
  | { ok: true; request: CompleteRequest }
  | { ok: false; status: number; error: string } {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Body must be a JSON object." };
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return { ok: false, status: 400, error: "messages is required (1 to 64)." };
  }
  for (const message of messages) {
    if (!isValidMessage(message)) {
      return { ok: false, status: 400, error: "Each message needs role 'user'|'assistant' and non-empty string content." };
    }
  }

  const system = typeof body.system === "string" ? body.system : undefined;
  if (system !== undefined && system.length > MAX_MESSAGE_LEN) {
    return { ok: false, status: 400, error: "system prompt too long." };
  }

  let tier: CompleteRequest["tier"];
  if (body.tier !== undefined) {
    if (typeof body.tier !== "string" || !VALID_TIERS.has(body.tier)) {
      return { ok: false, status: 400, error: "tier must be 'fast', 'balanced' or 'deep'." };
    }
    tier = body.tier as CompleteRequest["tier"];
  }

  const model = typeof body.model === "string" ? body.model : undefined;
  if (model !== undefined && model.length > 128) {
    return { ok: false, status: 400, error: "model id too long." };
  }

  let maxTokens: CompleteRequest["maxTokens"];
  if (body.maxTokens !== undefined) {
    if (typeof body.maxTokens !== "number" || !Number.isFinite(body.maxTokens) || body.maxTokens < 1 || body.maxTokens > MAX_MAX_TOKENS) {
      return { ok: false, status: 400, error: `maxTokens must be a number between 1 and ${MAX_MAX_TOKENS}.` };
    }
    maxTokens = body.maxTokens;
  }

  let temperature: CompleteRequest["temperature"];
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
      return { ok: false, status: 400, error: "temperature must be between 0 and 2." };
    }
    temperature = body.temperature;
  }

  let race: CompleteRequest["race"];
  if (body.race !== undefined) {
    if (typeof body.race !== "number" || !Number.isFinite(body.race) || body.race < 1 || body.race > MAX_RACE || !Number.isInteger(body.race)) {
      return { ok: false, status: 400, error: `race must be an integer between 1 and ${MAX_RACE}.` };
    }
    race = body.race;
  }

  return {
    ok: true,
    request: { messages, system, tier, model, maxTokens, temperature, race },
  };
}

/**
 * POST /api/providers/complete
 *
 * Runs a completion through the server-side multi-provider router using the
 * signed-in user's own providers and keys (decrypted server-side only). In
 * server mode host keys (SWARM_KEYS_<PROVIDER>) are never used; local mode
 * still falls back to them for the machine's single user. Keys never travel
 * to or from this route, and provider errors are redacted so no key material
 * can leak into the response body.
 */
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

  const check = validate(body);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const providers = routerProviders(user);
  const router = createRouter({ providers });
  try {
    const result = await router.complete(check.request);
    return NextResponse.json({
      text: result.text,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    if (err instanceof RouterError) {
      // RouterError messages are already redacted (no key material).
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json({ error: "Completion failed." }, { status: 500 });
  }
}
