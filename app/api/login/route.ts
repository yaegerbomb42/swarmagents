import { clearFailures, noteFailure, serverMode, sessionCookie, sessionToken, throttled } from "@/lib/auth";
import { authenticate, endSession, startSession } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Sign in: { username, password } → session cookie. */
export async function POST(req: Request) {
  if (!serverMode()) return Response.json({ error: "Accounts are only used on a hosted server." }, { status: 400 });
  if (throttled(req)) return Response.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  const { username, password } = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const user = authenticate(String(username ?? "").trim(), String(password ?? ""));
  if (!user) {
    await noteFailure(req);
    return Response.json({ error: "Wrong username or password." }, { status: 401 });
  }
  clearFailures(req);
  const res = Response.json({ ok: true, user: { username: user.username, isAdmin: user.isAdmin } });
  res.headers.append("Set-Cookie", sessionCookie(req, startSession(user.id)));
  return res;
}

/** Sign out: ends the session server-side, not just in this browser. */
export async function DELETE(req: Request) {
  endSession(sessionToken(req));
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookie(req, "", 0));
  return res;
}
