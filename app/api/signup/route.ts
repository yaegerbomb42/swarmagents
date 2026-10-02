import { checkOwnerToken, clearFailures, clientIp, noteFailure, serverMode, sessionCookie, throttled } from "@/lib/auth";
import { noteSignup, signupBlocked } from "@/lib/tenant/signup-limit"; // deploy lane: cap successful sign-ups
import { adminEmail } from "@/lib/tenant/admin";
import { signupCaptchaError, signupChallenge } from "@/lib/tenant/captcha"; // deploy lane: ALTCHA sign-up captcha
import { consumeInvite, createUser, inviteValid, signupMode, startSession, transaction, userCount, usernameTaken, validateCredentials } from "@/lib/users";

export const dynamic = "force-dynamic";

/**
 * Create an account: { username, password, invite }. The very first account must present the owner token as its
 * invite and becomes the admin, unless SWARM_ADMIN_EMAIL is set (then the admin is seeded at boot and no sign-up is
 * ever admin; a sign-up can't set an email). After that, SWARM_SIGNUP decides: "invite" (default) needs an unused invite from
 * an admin, "open" needs nothing, "closed" refuses.
 */
/** A fresh ALTCHA proof-of-work challenge for the sign-up form (lib/tenant/captcha.ts). */
export async function GET() {
  if (!serverMode()) return Response.json({ error: "Accounts are only used on a hosted server." }, { status: 400 });
  if (signupMode() === "closed") return Response.json({ error: "Sign-ups are closed." }, { status: 403 });
  return Response.json(await signupChallenge(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!serverMode()) return Response.json({ error: "Accounts are only used on a hosted server." }, { status: 400 });
  if (throttled(req)) return Response.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string; invite?: string; altcha?: string };
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const invite = String(body.invite ?? "").trim();
  const bad = validateCredentials(username, password);
  if (bad) return Response.json({ error: bad }, { status: 400 });

  // With SWARM_ADMIN_EMAIL configured, the admin comes only from bootstrapAdmin() at boot: no sign-up is ever admin.
  // Without it (legacy installs), the very first account is the admin and must present the owner token.
  const first = userCount() === 0 && !adminEmail();
  const mode = signupMode();
  if (!first && mode === "closed") return Response.json({ error: "Sign-ups are closed." }, { status: 403 });
  // deploy lane: every sign-up (except the legacy owner-token first account) must carry a solved, unused ALTCHA.
  if (!first) {
    const captcha = await signupCaptchaError(body.altcha);
    if (captcha) return Response.json({ error: captcha, captcha: true }, { status: 400 });
  }
  if (first && !checkOwnerToken(invite)) {
    await noteFailure(req);
    return Response.json({ error: "The first account needs the server's owner token as its invite code." }, { status: 403 });
  }

  // deploy lane: cap successful sign-ups per client and per hour (lib/tenant/signup-limit.ts).
  const capped = first ? null : signupBlocked(clientIp(req));
  if (capped) return Response.json({ error: capped }, { status: 429 });

  // Check the invite before the username, so someone without one can't probe which usernames exist.
  if (!first && mode === "invite" && !inviteValid(invite)) {
    await noteFailure(req);
    return Response.json({ error: "That invite code is not valid or was already used." }, { status: 403 });
  }

  let created;
  try {
    created = transaction(() => {
      if (usernameTaken(username)) throw new SignupError("That username is taken.", 409);
      const user = createUser(username, password, first);
      if (!first && mode === "invite" && !consumeInvite(invite, user.id)) throw new SignupError("That invite code is not valid or was already used.", 403);
      return user;
    });
  } catch (e) {
    if (!(e instanceof SignupError)) throw e;
    if (e.status === 403) await noteFailure(req);
    return Response.json({ error: e.message }, { status: e.status });
  }
  clearFailures(req);
  if (!first) noteSignup(clientIp(req)); // deploy lane
  const res = Response.json({ ok: true, user: { username: created.username, isAdmin: created.isAdmin } });
  res.headers.append("Set-Cookie", sessionCookie(req, startSession(created.id)));
  return res;
}

class SignupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
