/**
 * Signup bot check (FIX-44): Cloudflare Turnstile verification.
 *
 * Accounts consume real VM compute, so open sign-ups need a bot check in
 * front of POST /api/signup. The check is env-gated: when
 * SWARM_TURNSTILE_SECRET is set, the signup route requires a valid
 * Turnstile token (the client widget renders from
 * SWARM_TURNSTILE_SITE_KEY); when it is unset the check is skipped, so
 * local-mode and closed-signup deployments (SWARM_ALLOW_SIGNUP unset)
 * are unaffected. Operators who open sign-ups must set both keys — see
 * DEPLOY.md "Sign-up posture".
 *
 * verifyBotToken never throws: a network failure, a non-200, or a
 * malformed provider response is a failed check (fail closed when the
 * check is configured — an unreachable verifier must not wave bots
 * through).
 */

type Env = Record<string, string | undefined>;

/** Cloudflare Turnstile siteverify endpoint (fixed; not operator-tunable). */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Per-call timeout for the siteverify request. */
const VERIFY_TIMEOUT_MS = 5_000;

/** True when the bot check is configured (secret present). */
export function botCheckConfigured(env: Env = process.env): boolean {
  return Boolean(env.SWARM_TURNSTILE_SECRET?.trim());
}

/** The public site key for the client widget, or "" when unconfigured. */
export function botCheckSiteKey(env: Env = process.env): string {
  return env.SWARM_TURNSTILE_SITE_KEY?.trim() ?? "";
}

export type BotCheckResult = { ok: true } | { ok: false; error: string };

export interface VerifyBotTokenOptions {
  env?: Env;
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Client IP for the siteverify call, when known. */
  remoteIp?: string;
}

/**
 * Verify a Turnstile token from the signup form. Returns ok when the
 * check is not configured (see module doc). When configured, a missing
 * token, a provider rejection, or any transport failure is a failure —
 * the caller (signup route) turns that into a 400 without creating the
 * account. The secret and token are sent only to the provider endpoint
 * and are never logged here.
 */
export async function verifyBotToken(token: unknown, options: VerifyBotTokenOptions = {}): Promise<BotCheckResult> {
  const env = options.env ?? process.env;
  const secret = env.SWARM_TURNSTILE_SECRET?.trim();
  if (!secret) return { ok: true }; // not configured: closed/local deployments skip the check
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, error: "missing bot-check token" };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const body = new URLSearchParams({ secret, response: token });
  if (options.remoteIp) body.set("remoteip", options.remoteIp);
  let res: Response;
  try {
    res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "bot-check request failed" };
  }
  if (!res.ok) return { ok: false, error: `bot-check provider returned ${res.status}` };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "bot-check provider returned malformed JSON" };
  }
  const success =
    typeof data === "object" && data !== null && (data as { success?: unknown }).success === true;
  return success ? { ok: true } : { ok: false, error: "bot check rejected the token" };
}
