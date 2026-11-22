import { NextResponse, type NextRequest } from "next/server";
import { createRouter, type CompleteRequest } from "@/lib/providers";
import { RouterError } from "@/lib/providers/errors";
import { routerProviders } from "@/lib/providers/store";
import { USER_HEADER } from "@/lib/auth";
import { TokenBucket } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const MAX_BODY_SIZE = 256 * 1024;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_LEN = 20_000;
const MAX_MAX_TOKENS = 4096;
const MAX_RACE = 8;

const VALID_TIERS = new Set(["fast", "balanced", "deep"]);

function perMinute(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Completions cost money and race up to 8 upstream calls, so they get their
 * own per-user budget (separate from the general API bucket).
 */
const completeBucket = new TokenBucket(
  perMinute("SWARM_PROVIDERS_COMPLETE_RATE_LIMIT_PER_MIN", 60),
  60_000,
);

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE, ...(extraHeaders ?? {}) },
  });
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

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
  }
  return err instanceof Error && err.message.toLowerCase().includes("aborted");
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

  let system: string | undefined;
  if (body.system !== undefined) {
    if (typeof body.system !== "string") {
      return { ok: false, status: 400, error: "system must be a string." };
    }
    if (body.system.length > MAX_MESSAGE_LEN) {
      return { ok: false, status: 400, error: "system prompt too long." };
    }
    system = body.system;
  }

  let tier: CompleteRequest["tier"];
  if (body.tier !== undefined) {
    if (typeof body.tier !== "string" || !VALID_TIERS.has(body.tier)) {
      return { ok: false, status: 400, error: "tier must be 'fast', 'balanced' or 'deep'." };
    }
    tier = body.tier as CompleteRequest["tier"];
  }

  let model: string | undefined;
  if (body.model !== undefined) {
    if (typeof body.model !== "string") {
      return { ok: false, status: 400, error: "model must be a string." };
    }
    if (!body.model.trim()) {
      return { ok: false, status: 400, error: "model must be a non-empty string." };
    }
    if (body.model.length > 128) {
      return { ok: false, status: 400, error: "model id too long." };
    }
    model = body.model;
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

  const rate = completeBucket.consume(`providers-complete:${user}`);
  if (!rate.allowed) {
    return json(
      { error: "Too many completion requests — try again in a moment." },
      429,
      { "Retry-After": String(rate.retryAfter) },
    );
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
    const result = await router.complete({ ...check.request, signal: req.signal });
    return json({
      text: result.text,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    if (isAbortError(err, req.signal)) {
      return json({ error: "Request aborted." }, 499);
    }
    if (err instanceof RouterError) {
      // RouterError messages are already redacted (no key material).
      return json({ error: err.message }, 502);
    }
    return json({ error: "Completion failed." }, 500);
  }
}

/** Test-only: reset the completion rate-limit bucket. */
export function _resetCompleteBucketForTests(): void {
  completeBucket._clear();
}
