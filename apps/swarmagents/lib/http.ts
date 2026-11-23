/**
 * Shared HTTP helpers for API routes.
 *
 * `readJsonBody` is the one bounded JSON body reader: it reads the request
 * body as a stream, enforcing a UTF-8 byte cap as chunks arrive (the stream
 * is cancelled the moment the cap is exceeded, so an oversized body is
 * rejected before the rest of it is buffered) and parses JSON (400 on
 * malformed or empty bodies). Routes that used to call bare `request.json()`
 * or `request.text()` with no size cap should use this instead so a huge
 * body cannot exhaust memory before validation runs. Behaviour is otherwise
 * identical to `request.json()` followed by the route's own shape checks.
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
 * Read a request body as text with a byte-size cap enforced while the body
 * is still arriving. Bytes are counted on the wire (UTF-8 bytes, not UTF-16
 * code units — a multibyte body cannot smuggle up to 3x the cap past the
 * check), and the stream is cancelled as soon as the cap is exceeded, so an
 * oversized body is rejected before the rest of it is buffered. Throws
 * `JsonBodyError` with status 413 when the body exceeds `maxBytes` and 400
 * when the body cannot be read at all.
 *
 * When the request carries no body stream (an empty body, or a test double
 * that only implements `.text()`), falls back to `request.text()` with the
 * same byte cap applied afterwards.
 */
export async function readBoundedText(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<string> {
  const stream = request.body;
  if (!stream || typeof stream.getReader !== "function") {
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

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Stop the sender and refuse the rest instead of buffering it.
        try {
          await reader.cancel();
        } catch {
          // The 413 below is the answer; a cancel failure changes nothing.
        }
        throw new JsonBodyError("Request body is too large.", 413);
      }
      // Streaming decode: a multibyte character split across two chunks
      // still decodes to the one character it is.
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (err) {
    if (err instanceof JsonBodyError) throw err;
    throw new JsonBodyError("Could not read the request body.", 400);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader is already released or closed; nothing to do.
    }
  }
  return chunks.join("");
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
  const text = await readBoundedText(request, maxBytes);
  if (!text.trim()) {
    throw new JsonBodyError("Invalid JSON body.", 400);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonBodyError("Invalid JSON body.", 400);
  }
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
