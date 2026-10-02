import { requestUser, serverMode } from "@/lib/auth";
import { signupMode, userCount } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Who am I, and how can someone sign up here? Public, so the sign-in page can adapt. */
export async function GET(req: Request) {
  const user = requestUser(req);
  if (!serverMode()) return Response.json({ mode: "local", user: user && { username: user.username, isAdmin: true } });
  return Response.json({
    mode: "server",
    user: user && { username: user.username, isAdmin: user.isAdmin },
    signup: signupMode(),
    needsAdmin: userCount() === 0,
  });
}
