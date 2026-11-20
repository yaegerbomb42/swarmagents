import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { requestUser, safeNextPath } from "../../lib/auth";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Whether POST /api/signup will accept new accounts: self-signup is open in
 * development and only when SWARM_ALLOW_SIGNUP is explicitly enabled in
 * production. Mirrors the check in app/api/signup/route.ts.
 */
function signupSupported(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const allow = (process.env.SWARM_ALLOW_SIGNUP ?? "").toLowerCase();
  return allow === "1" || allow === "true";
}

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

  return <LoginForm next={target} allowSignup={signupSupported()} />;
}
