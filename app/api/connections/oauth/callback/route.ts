import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { mcpServerDef, onMcpChangeNotify } from "@/lib/connections";
import { McpOAuthProvider, pendingStates } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const back = (q: string) => Response.redirect(`${u.origin}/?${q}`);
  const state = u.searchParams.get("state") ?? "";
  const code = u.searchParams.get("code");
  const pending = pendingStates.get(state);
  if (!pending) return back(`connect_error=${encodeURIComponent("That sign-in link expired. Try again from Settings.")}`);
  pendingStates.delete(state);
  if (!code) return back(`connect_error=${encodeURIComponent(u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? "Sign-in was cancelled.")}`);
  const def = mcpServerDef(pending.name);
  if (!def?.url) return back(`connect_error=${encodeURIComponent("That MCP server was removed.")}`);
  try {
    const provider = new McpOAuthProvider(pending.name, `${u.origin}/api/connections/oauth/callback`);
    await auth(provider, { serverUrl: def.url, authorizationCode: code });
    onMcpChangeNotify(pending.name);
    return back(`connected=${encodeURIComponent(`mcp:${pending.name}`)}`);
  } catch (e) {
    return back(`connect_error=${encodeURIComponent(`${pending.name}: ${((e as Error).message || "token exchange failed").slice(0, 160)}`)}`);
  }
}
