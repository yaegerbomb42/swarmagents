import crypto from "node:crypto";

export const dynamic = "force-dynamic";

import { verifiers } from "@/lib/oauth";
import { publicOrigin, redirectTo } from "@/lib/http";

// OpenRouter OAuth (PKCE): the user logs in on openrouter.ai and we receive a key for their account.

export async function GET(req: Request) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  verifiers.set(verifier, Date.now());
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const origin = publicOrigin(req);
  const cb = `${origin}/api/connect/openrouter/callback?v=${verifier}`;
  return redirectTo(`https://openrouter.ai/auth?callback_url=${encodeURIComponent(cb)}&code_challenge=${challenge}&code_challenge_method=S256`);
}
