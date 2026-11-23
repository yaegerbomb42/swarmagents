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

type ParsedBody =
  | { ok: true; connectorId: string; inputs?: Record<string, string>; useProviderKey?: boolean }
  | { ok: false; response: NextResponse };

function parseConnectorId(body: Record<string, unknown>): { ok: true; id: string } | { ok: false; response: NextResponse } {
  if (typeof body.connectorId !== "string" || !body.connectorId.trim()) {
    return { ok: false, response: json({ error: "connectorId is required." }, { status: 400 }) };
  }
  const connectorId = body.connectorId.trim();
  if (!findCatalogConnector(connectorId)) {
    return { ok: false, response: json({ error: "Unknown connector." }, { status: 404 }) };
  }
  return { ok: true, id: connectorId };
}

function parseInputs(
  body: Record<string, unknown>,
): { ok: true; inputs?: Record<string, string> } | { ok: false; response: NextResponse } {
  if (body.inputs === undefined) return { ok: true };
  if (!isRecord(body.inputs)) {
    return { ok: false, response: json({ error: "inputs must be an object." }, { status: 400 }) };
  }
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.inputs)) {
    if (typeof value !== "string") {
      return { ok: false, response: json({ error: `Field "${key}" must be a string.` }, { status: 400 }) };
    }
    inputs[key] = value;
  }
  return { ok: true, inputs };
}

function parseBody(body: unknown): ParsedBody {
  if (!isRecord(body)) {
    return { ok: false, response: json({ error: "connectorId is required." }, { status: 400 }) };
  }
  const id = parseConnectorId(body);
  if (!id.ok) return { ok: false, response: id.response };
  const parsedInputs = parseInputs(body);
  if (!parsedInputs.ok) return { ok: false, response: parsedInputs.response };
  return {
    ok: true,
    connectorId: id.id,
    inputs: parsedInputs.inputs,
    useProviderKey: typeof body.useProviderKey === "boolean" ? body.useProviderKey : undefined,
  };
}

function errorFallback(err: unknown): NextResponse {
  return json(
    { error: err instanceof Error ? err.message : "Could not connect service." },
    { status: 400 },
  );
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

  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.response;

  try {
    const connector = await connectConnector(owner, parsed.connectorId, {
      inputs: parsed.inputs,
      useProviderKey: parsed.useProviderKey,
    });
    return json({ connector }, { status: 201 });
  } catch (err) {
    if (err instanceof ConnectorError) {
      return json({ error: err.message }, { status: err.status });
    }
    return errorFallback(err);
  }
}
