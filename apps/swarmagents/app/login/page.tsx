import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { requestUser, safeNextPath, signupAllowed } from "../../lib/auth";
import { botCheckSiteKey } from "../../lib/bot-check";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Sign-in page. Middleware sends unauthenticated visitors here with
 * ?next=<path>; the form POSTs to /api/login (or /api/signup) and follows the
 * returned, server-validated `next`. Users who already hold a valid session
 * are bounced straight back to their destination.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = safeNextPath(next);

  const [hdrs, cs] = await Promise.all([headers(), cookies()]);
  const user = requestUser({ headers: hdrs, cookies: { get: (name) => cs.get(name) } });
  if (user) redirect(target);

  // The toggle renders iff POST /api/signup would accept an account:
  // signupAllowed() in lib/auth is the one predicate both sides call.
  // The Turnstile site key (FIX-44) is empty when the bot check is not
  // configured; the form renders the widget only when it is present.
  return <LoginForm next={target} allowSignup={signupAllowed()} turnstileSiteKey={botCheckSiteKey()} />;
}
