import { NextResponse } from "next/server";
import { searchMcpRegistry } from "@/lib/connectors/registry";
import { ConnectorError, installRegistryMcp } from "@/lib/connectors/store";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { providerOwner } from "@/lib/providers/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { ...init, headers: NO_STORE });
}

function unauthorized() {
  return json({ error: "Sign in required." }, { status: 401 });
}

export async function GET(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  const limitRaw = Number(searchParams.get("limit") ?? "24");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 50) : 24;

  try {
    const servers = await searchMcpRegistry(q, { limit });
    return json({ query: q, servers });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Could not reach MCP registry." },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid request payload." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id : "";
  const name = typeof input.name === "string" ? input.name : id;
  const description = typeof input.description === "string" ? input.description : undefined;
  const transport = input.transport === "stdio" ? "stdio" : input.transport === "http" ? "http" : null;
  if (!transport) {
    return json({ error: "transport must be 'http' or 'stdio'." }, { status: 400 });
  }

  try {
    const item = installRegistryMcp(owner, {
      id,
      name,
      description,
      transport,
      url: typeof input.url === "string" ? input.url : undefined,
      packageManager: input.packageManager === "uvx" ? "uvx" : "npx",
      packageName: typeof input.packageName === "string" ? input.packageName : undefined,
    });
    return json({ item }, { status: 201 });
  } catch (err) {
    if (err instanceof ConnectorError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: err instanceof Error ? err.message : "Install failed." }, { status: 400 });
  }
}
