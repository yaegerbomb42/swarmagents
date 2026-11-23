/**
 * Safe error→response translation for lens POSTs. Next.js route files may
 * only export route handlers, so this helper lives here (lib) where it can
 * also be unit-tested directly.
 */

import { noStoreJson } from "../http";
import { RouterError } from "../providers/router";

/**
 * Translate a lens failure into a safe 502 response. Only RouterError
 * messages are surfaced (they are already redacted — no key material). Any
 * other error — a programming bug or an unexpected provider/library failure —
 * must not leak internals, so it becomes a generic message.
 */
export function lensErrorResponse(err: unknown): Response {
  if (err instanceof RouterError && err.message) {
    return noStoreJson({ error: err.message }, { status: 502 });
  }
  return noStoreJson({ error: "Lens failed." }, { status: 502 });
}
