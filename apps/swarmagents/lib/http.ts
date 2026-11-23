/**
 * Shared HTTP helpers for API routes.
 *
 * `readJsonBody` is the one bounded JSON body reader: it streams the
 * request body, enforces a byte-size cap while reading (413, cancelling the
 * stream the moment the cap is crossed) and parses JSON (400 on malformed
 * or empty bodies). Routes that used to call bare `request.json()` with no
 * size cap should use this instead so a huge body cannot exhaust memory
 * before validation runs. Behaviour is otherwise identical to `request.json()`
 * followed by the route's own shape checks.
 */

import { NextResponse } from "next/server";

export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;

/** Header that marks a per-user or otherwise dynamic reply as uncacheable. */
export const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * A JSON reply that must never be cached. Per-user state (projects, pairing
 * codes, lens answers) and error branches that echo request shape are all
 * cacheable-by-default unless the route says otherwise, and a cached copy
 * serves one account's state to the next reader. `noStoreJson` is the one
 * place that sets the header so no branch is forgotten.
 */
export function noStoreJson(body: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

/** Thrown by `readJsonBody` when the body is unreadable, oversized or invalid. */
export class JsonBodyError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = "JsonBodyError";
    this.status = status;
  }
}

/**
 * Read a JSON request body with a size cap. Returns the parsed value (any
 * JSON value — callers validate the shape, as before). Throws `JsonBodyError`
 * with status 400 for an unreadable/empty/malformed body and 413 when the
 * body exceeds `maxBytes`.
 *
 * The cap is enforced while streaming: chunks are counted as they arrive
 * and the reader is cancelled the moment the total crosses `maxBytes`, so
 * an oversized body is never fully buffered. (Reading `request.text()`
 * first and measuring afterwards would hold the whole body in memory —
 * exactly the exhaustion the cap exists to prevent.)
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const text = await readBodyTextCapped(request, maxBytes);
  if (!text.trim()) {
    throw new JsonBodyError("Invalid JSON body.", 400);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonBodyError("Invalid JSON body.", 400);
  }
}

/** Read a request body as UTF-8 text, aborting as soon as it exceeds `maxBytes`. */
async function readBodyTextCapped(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (!body) {
    // No stream to meter (bodyless request object): fall back to text() and
    // measure what arrived.
    let text: string;
    try {
      text = await request.text();
    } catch {
      throw new JsonBodyError("Could not read the request body.", 400);
    }
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new JsonBodyError("Request body is too large.", 413);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new JsonBodyError("Request body is too large.", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof JsonBodyError) throw err;
    throw new JsonBodyError("Could not read the request body.", 400);
  } finally {
    reader.releaseLock();
  }
  // Decode only after concatenating so a multi-byte character split across
  // chunks is reassembled before it is interpreted.
  return Buffer.concat(chunks).toString("utf8");
}

type JsonObject = Record<string, unknown>;
export type JsonObjectRead =
  | { ok: true; value: JsonObject }
  | { ok: false; response: NextResponse };

/**
 * Read a bounded JSON body that must be a plain object. Keeps the 400/413
 * replies of the routes that used to repeat this parsing block in one place,
 * and never lets a successful reply be cached.
 */
export async function readJsonObject(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<JsonObjectRead> {
  let value: unknown;
  try {
    value = await readJsonBody(request, maxBytes);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      const message = err.status === 413 ? "Request body too large." : err.message;
      return { ok: false, response: noStoreJson({ error: message }, { status: err.status }) };
    }
    return { ok: false, response: noStoreJson({ error: "Invalid JSON body." }, { status: 400 }) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, response: noStoreJson({ error: "Body must be a JSON object." }, { status: 400 }) };
  }
  return { ok: true, value: value as JsonObject };
}

/** Map a route error to an uncacheable JSON reply, preserving its HTTP status. */
export function noStoreRouteError(err: unknown, fallbackMessage: string): NextResponse {
  const candidate = err as { status?: unknown; message?: unknown } | null;
  const status = candidate?.status;
  const message = candidate?.message;
  if (typeof status === "number" && status >= 400 && status < 600 && typeof message === "string" && message) {
    return noStoreJson({ error: message }, { status });
  }
  return noStoreJson({ error: fallbackMessage }, { status: 500 });
}
