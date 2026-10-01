import { AUTH_COOKIE, authEnabled, checkToken, clientIp, hostAllowed, misconfigured, serverMode } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Failed attempts are slowed per client so a token can't be guessed online (tokens should be long and random anyway).
// A global cap also stops guessing spread across many addresses.
const failures = new Map<string, { n: number; at: number }>();
let global = { n: 0, at: 0 };

export async function POST(req: Request) {
  if (misconfigured()) return Response.json({ error: "Server is not configured." }, { status: 503 });
  if (!hostAllowed(req)) return new Response("forbidden", { status: 403 });
  if (!authEnabled()) return Response.json({ error: "Sign-in is not enabled on this server." }, { status: 400 });
  const now = Date.now();
  if (now - global.at > 60_000) global = { n: 0, at: now };
  const who = clientIp(req);
  const f = failures.get(who);
  if ((f && f.n >= 5 && now - f.at < 60_000) || global.n >= 30) return Response.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!checkToken(String(token ?? ""))) {
    failures.set(who, { n: (f && now - f.at < 60_000 ? f.n : 0) + 1, at: now });
    global.n++;
    if (failures.size > 10_000) failures.clear();
    await new Promise((r) => setTimeout(r, 700));
    return Response.json({ error: "That token is not right." }, { status: 401 });
  }
  failures.delete(who);
  const secure = serverMode() || (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${AUTH_COOKIE}=${encodeURIComponent(String(token))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${secure ? "; Secure" : ""}`);
  return res;
}

export async function DELETE() {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return res;
}
