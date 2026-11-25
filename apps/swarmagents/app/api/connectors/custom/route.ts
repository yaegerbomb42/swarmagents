import { NextResponse } from "next/server";
import {
  ConnectorError,
  listCustomConnectors,
  removeCustomConnector,
} from "@/lib/connectors/store";
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

export function GET(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  return json({ items: listCustomConnectors(owner) });
}

export function DELETE(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") ?? "";
  try {
    const removed = removeCustomConnector(owner, id);
    return json({ ok: true, removed });
  } catch (err) {
    if (err instanceof ConnectorError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: "Could not remove custom tool." }, { status: 400 });
  }
}
