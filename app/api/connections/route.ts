import { InputError, catalog, deleteConnection, listConnections, reorderProviders, setEnabled, upsertConnection, type ConnectionInput } from "@/lib/connections";
import type { ConnType } from "@/lib/presets";
import { scoped } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Every connection the user manages in Settings (LLM providers, tool keys, MCP servers) through one API.
// Secrets are write-only: responses carry key hints, never keys.

const TYPES: ConnType[] = ["llm", "tool", "mcp"];
const list = (extra?: Record<string, unknown>) => Response.json({ connections: listConnections(), ...extra });

function fail(e: unknown) {
  if (e instanceof InputError) return Response.json({ error: e.message }, { status: 400 });
  console.error("[connections]", e);
  return Response.json({ error: "Couldn't save that connection. See the server log for details." }, { status: 500 });
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new InputError("Request body must be valid JSON.");
  }
}

async function handleGET() {
  return list({ catalog: catalog() });
}

/** Upsert: { type, id?, preset, ...fields }. Toggle only: { type, id, enabled }. */
async function handlePOST(req: Request) {
  try {
    const b = await body<ConnectionInput>(req);
    if (!TYPES.includes(b.type)) throw new InputError("Unknown connection type.");
    const keys = Object.keys(b).filter((k) => k !== "type" && k !== "id");
    if (b.id && keys.length === 1 && keys[0] === "enabled") {
      setEnabled(b.type, b.id, !!b.enabled);
      return list({ id: b.id });
    }
    const { id } = upsertConnection(b);
    return list({ id });
  } catch (e) {
    return fail(e);
  }
}

/** Reorder LLM providers (failover priority): { order: string[] }. */
async function handlePUT(req: Request) {
  try {
    const { order } = await body<{ order: unknown }>(req);
    if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) throw new InputError("order must be a list of provider ids.");
    reorderProviders(order as string[]);
    return list();
  } catch (e) {
    return fail(e);
  }
}

/** DELETE ?type=llm|tool|mcp&id=… */
async function handleDELETE(req: Request) {
  try {
    const u = new URL(req.url);
    const type = u.searchParams.get("type") as ConnType;
    const id = u.searchParams.get("id");
    if (!TYPES.includes(type) || !id) throw new InputError("type and id are required.");
    deleteConnection(type, id);
    return list();
  } catch (e) {
    return fail(e);
  }
}

// Every handler runs as the signed-in account, so all storage it touches is that account's (lib/store userHome()).
export const GET = scoped(handleGET);
export const POST = scoped(handlePOST);
export const PUT = scoped(handlePUT);
export const DELETE = scoped(handleDELETE);
