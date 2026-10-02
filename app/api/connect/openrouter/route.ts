import crypto from "node:crypto";

export const dynamic = "force-dynamic";

import { verifiers } from "@/lib/oauth";
import { currentUser } from "@/lib/store";
import { publicOrigin, redirectTo } from "@/lib/http";
import { scoped } from "@/lib/auth";

// Which account started each OpenRouter login (verifier -> user), so a callback only finishes its own user's login.
const owners = ((globalThis as unknown as { __swarmOrOwners?: Map<string, string> }).__swarmOrOwners ??= new Map<string, string>());

// OpenRouter OAuth (PKCE): the user logs in on openrouter.ai and we receive a key for their account.

async function handleGET(req: Request) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  verifiers.set(verifier, Date.now());
  owners.set(verifier, currentUser());
  for (const k of owners.keys()) if (!verifiers.has(k)) owners.delete(k);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const origin = publicOrigin(req);
  const cb = `${origin}/api/connect/openrouter/callback?v=${verifier}`;
  return redirectTo(`https://openrouter.ai/auth?callback_url=${encodeURIComponent(cb)}&code_challenge=${challenge}&code_challenge_method=S256`);
}

// Every handler runs as the signed-in account, so all storage it touches is that account's (lib/store userHome()).
export const GET = scoped(handleGET);
