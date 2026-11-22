import { NextResponse, type NextRequest } from "next/server";
import { createRouter, type CompleteRequest } from "@/lib/providers";
import { AbortError, RouterError } from "@/lib/providers/errors";
import { routerProviders } from "@/lib/providers/store";
import { USER_HEADER } from "@/lib/auth";
import { checkCompleteRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 256 * 1024;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_LEN = 20_000;
const MAX_MAX_TOKENS = 4096;
const MAX_RACE = 8;

const VALID_TIERS = new Set(["fast", "balanced", "deep"]);

const NO_STORE = { "cache-control": "no-store" } as const;

/** Every response from this route is per-user live state: never cacheable. */
function json(body: unknown, status: number, retryAfter?: number): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  return NextResponse.json(body, { status, headers });
}

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return json({ error: "Sign in required." }, 401);
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
  if (body.system !== undefined && typeof body.system !== "string") {
    return { ok: false, status: 400, error: "system must be a string." };
  }
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

  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim().length === 0) {
      return { ok: false, status: 400, error: "model must be a non-empty string." };
    }
    if (body.model.length > 128) {
      return { ok: false, status: 400, error: "model id too long." };
    }
  }
  const model = typeof body.model === "string" ? body.model : undefined;

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

  // Per-user budget, checked before any body work: one completion can fan
  // out to 8 upstream LLM calls, so a flood here is spend, not just load.
  const limit = checkCompleteRateLimit(user);
  if (!limit.allowed) {
    return json({ error: "Too many completion requests. Try again later." }, 429, limit.retryAfter);
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return json({ error: "Could not read request body." }, 400);
  }
  if (text.length > MAX_BODY_SIZE) {
    return json({ error: "Request body too large." }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const check = validate(body);
  if (!check.ok) {
    return json({ error: check.error }, check.status);
  }

  const providers = routerProviders(user);
  const router = createRouter({ providers });
  try {
    // The client's disconnect aborts the in-flight/raced upstream calls.
    const result = await router.complete({ ...check.request, signal: req.signal });
    return json({
      text: result.text,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    }, 200);
  } catch (err) {
    if (req.signal.aborted || err instanceof AbortError || (err instanceof RouterError && err.code === "aborted")) {
      return json({ error: "Request aborted." }, 499);
    }
    if (err instanceof RouterError) {
      // RouterError messages are already redacted (no key material).
      return json({ error: err.message }, 502);
    }
    return json({ error: "Completion failed." }, 500);
  }
}
