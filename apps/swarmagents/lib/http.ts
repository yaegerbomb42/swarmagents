/**
 * Shared HTTP helpers for API routes.
 *
 * `readJsonBody` is the one bounded JSON body reader: it reads the request
 * as text, enforces a byte-size cap (413) and parses JSON (400 on malformed
 * or empty bodies). Routes that used to call bare `request.json()` with no
 * size cap should use this instead so a huge body cannot exhaust memory
 * before validation runs. Behaviour is otherwise identical to `request.json()`
 * followed by the route's own shape checks.
 */

export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;

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
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new JsonBodyError("Could not read the request body.", 400);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new JsonBodyError("Request body is too large.", 413);
  }
  if (!text.trim()) {
    throw new JsonBodyError("Invalid JSON body.", 400);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonBodyError("Invalid JSON body.", 400);
  }
}
