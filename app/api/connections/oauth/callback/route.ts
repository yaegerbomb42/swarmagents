import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { mcpServerDef, onMcpChangeNotify } from "@/lib/connections";
import { McpOAuthProvider, pendingStates } from "@/lib/mcp-oauth";
import { currentUser } from "@/lib/store";

import { publicOrigin, redirectTo } from "@/lib/http";
import { scoped } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  const u = new URL(req.url);
  const back = (q: string) => redirectTo(`/?${q}`);
  const state = u.searchParams.get("state") ?? "";
  const code = u.searchParams.get("code");
  const pending = pendingStates.get(state);
  if (!pending || pending.user !== currentUser()) return back(`connect_error=${encodeURIComponent("That sign-in link expired. Try again from Settings.")}`);
  pendingStates.delete(state);
  if (!code) return back(`connect_error=${encodeURIComponent(u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? "Sign-in was cancelled.")}`);
  const def = mcpServerDef(pending.name);
  if (!def?.url) return back(`connect_error=${encodeURIComponent("That MCP server was removed.")}`);
  try {
    const provider = new McpOAuthProvider(pending.name, `${publicOrigin(req)}/api/connections/oauth/callback`);
    await auth(provider, { serverUrl: def.url, authorizationCode: code });
    onMcpChangeNotify(pending.name);
    return back(`connected=${encodeURIComponent(`mcp:${pending.name}`)}`);
  } catch (e) {
    return back(`connect_error=${encodeURIComponent(`${pending.name}: ${((e as Error).message || "token exchange failed").slice(0, 160)}`)}`);
  }
}

// Every handler runs as the signed-in account, so all storage it touches is that account's (lib/store userHome()).
export const GET = scoped(handleGET);
