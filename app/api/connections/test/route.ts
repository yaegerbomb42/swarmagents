import { testConnection, type ConnectionInput } from "@/lib/connections";
import { scoped } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Test a connection before or after saving it: lists models, checks a tool key, or connects to an MCP server. */
async function handlePOST(req: Request) {
  let b: ConnectionInput;
  try {
    b = (await req.json()) as ConnectionInput;
  } catch {
    return Response.json({ ok: false, message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!b || !["llm", "tool", "mcp"].includes(b.type)) return Response.json({ ok: false, message: "Unknown connection type." }, { status: 400 });
  try {
    return Response.json(await testConnection(b));
  } catch (e) {
    console.error("[connections/test]", e);
    return Response.json({ ok: false, message: "The test crashed. See the server log for details." }, { status: 500 });
  }
}

// Every handler runs as the signed-in account, so all storage it touches is that account's (lib/store userHome()).
export const POST = scoped(handlePOST);
