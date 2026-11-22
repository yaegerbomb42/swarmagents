import { NextResponse } from "next/server";
import {
  CONNECTOR_CATEGORIES,
  findCatalogConnector,
} from "@/lib/connectors/catalog";
import {
  connectConnector,
  ConnectorError,
  listConnectorStatuses,
} from "@/lib/connectors/store";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function GET(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const connectors = listConnectorStatuses(owner);
  return json({
    categories: CONNECTOR_CATEGORIES,
    connectors,
  });
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

  if (!isRecord(body) || typeof body.connectorId !== "string" || !body.connectorId.trim()) {
    return json({ error: "connectorId is required." }, { status: 400 });
  }

  const connectorId = body.connectorId.trim();
  if (!findCatalogConnector(connectorId)) {
    return json({ error: "Unknown connector." }, { status: 404 });
  }

  let inputs: Record<string, string> | undefined;
  if (body.inputs !== undefined) {
    if (!isRecord(body.inputs)) {
      return json({ error: "inputs must be an object." }, { status: 400 });
    }
    inputs = {};
    for (const [k, v] of Object.entries(body.inputs)) {
      if (typeof v !== "string") {
        return json({ error: `Field "${k}" must be a string.` }, { status: 400 });
      }
      inputs[k] = v;
    }
  }

  const useProviderKey =
    typeof body.useProviderKey === "boolean" ? body.useProviderKey : undefined;

  try {
    const connector = await connectConnector(owner, connectorId, {
      inputs,
      useProviderKey,
    });
    return json({ connector }, { status: 201 });
  } catch (err) {
    if (err instanceof ConnectorError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json(
      { error: err instanceof Error ? err.message : "Could not connect service." },
      { status: 400 },
    );
  }
}
