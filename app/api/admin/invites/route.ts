import { requestUser, serverMode } from "@/lib/auth";
import { createInvite } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Admins mint single-use invite codes (valid 7 days); returns the code and a ready-to-share sign-up link. */
export async function POST(req: Request) {
  const user = requestUser(req);
  if (!serverMode() || !user?.isAdmin) return Response.json({ error: "Admins only." }, { status: 403 });
  const code = createInvite(user.id);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return Response.json({ code, url: `${proto}://${host}/login?invite=${encodeURIComponent(code)}` });
}
