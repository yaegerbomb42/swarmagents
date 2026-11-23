/**
 * The log redactor for a board-agent turn.
 *
 * A turn failure is logged server-side with the error message attached, and
 * that message can carry a secret the provider echoed back. The env-only
 * redactor is not enough: a caller's BYOK provider keys live in the
 * per-user provider store, not in process.env, so they are passed as
 * extra secrets here. An unreadable provider store must not break the error
 * path itself, so key loading fails open to the env-only redactor.
 */

import { makeRedactor } from "../harness/redact";
import { routerProviders } from "../providers/store";

export function boardAgentLogRedactor(userId: string): (text: string) => string {
  let keys: string[] = [];
  try {
    keys = routerProviders(userId).flatMap((config) => config.keys ?? []);
  } catch {
    keys = [];
  }
  return makeRedactor(process.env as Record<string, string>, keys);
}
