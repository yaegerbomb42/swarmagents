import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { mcpServerDef } from "@/lib/connections";
import { McpOAuthProvider } from "@/lib/mcp-oauth";

import { publicOrigin, redirectTo } from "@/lib/http";

export const dynamic = "force-dynamic";

// One-click sign-in for a remote MCP server: discovery, dynamic client registration and PKCE via the MCP SDK.
// GET ?name=<server> redirects the browser to the server's login page; the callback stores the tokens.

export async function GET(req: Request) {
  const u = new URL(req.url);
  const name = u.searchParams.get("name") ?? "";
  const back = (q: string) => redirectTo(`/?${q}`);
  const def = mcpServerDef(name);
  if (!def?.url) return back(`connect_error=${encodeURIComponent("That MCP server has no URL to sign in to.")}`);
  const provider = new McpOAuthProvider(name, `${publicOrigin(req)}/api/connections/oauth/callback`);
  try {
    const result = await auth(provider, { serverUrl: def.url });
    if (result === "AUTHORIZED") return back(`connected=${encodeURIComponent(`mcp:${name}`)}`);
    if (provider.authorizationUrl) return redirectTo(provider.authorizationUrl.toString());
    return back(`connect_error=${encodeURIComponent("The server didn't offer a sign-in page.")}`);
  } catch (e) {
    const msg = (e as Error).message || "sign-in failed";
    console.error("[mcp oauth]", name, msg);
    return back(`connect_error=${encodeURIComponent(`${name}: ${msg.slice(0, 160)}`)}`);
  }
}
