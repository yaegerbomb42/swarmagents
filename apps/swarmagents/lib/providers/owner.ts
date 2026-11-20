/**
 * Whose providers a request may touch.
 *
 * The middleware overwrites the user header on every request with the
 * verified session (or harness) user, so route handlers can trust it. In
 * server mode a request without it is refused — there is no shared default
 * account to fall back to. Local (single-user) mode keeps the "local" owner
 * for direct calls without the header.
 */

import { serverMode, USER_HEADER } from "../auth";

const MAX_OWNER_LEN = 128;

export function providerOwner(request: Request): string | null {
  const user = request.headers.get(USER_HEADER);
  if (user && user.length > 0 && user.length <= MAX_OWNER_LEN) return user;
  return serverMode() ? null : "local";
}
