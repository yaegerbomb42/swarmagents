import { NextResponse } from "next/server";
import {
  ConnectorError,
  disconnectConnector,
  getConnectorStatus,
} from "@/lib/connectors/store";
import { providerOwner } from "@/lib/providers/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function json(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { ...init, headers: NO_STORE });
}

function unauthorized() {
  return json({ error: "Sign in required." }, { status: 401 });
}

async function resolveId(ctx: RouteContext): Promise<string> {
  const params = await Promise.resolve(ctx.params);
  return typeof params?.id === "string" ? params.id.trim() : "";
}

export async function GET(request: Request, ctx: RouteContext) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const id = await resolveId(ctx);
  if (!id) return json({ error: "Connector id is required." }, { status: 400 });

  const connector = getConnectorStatus(owner, id);
  if (!connector) return json({ error: "Connector not found." }, { status: 404 });
  return json({ connector });
}

export async function DELETE(request: Request, ctx: RouteContext) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const id = await resolveId(ctx);
  if (!id) return json({ error: "Connector id is required." }, { status: 400 });

  try {
    const result = disconnectConnector(owner, id);
    return json({ ok: true, removed: result.removed, connector: result.connector });
  } catch (err) {
    if (err instanceof ConnectorError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json(
      { error: err instanceof Error ? err.message : "Could not disconnect service." },
      { status: 400 },
    );
  }
}
