import { getLimits, getProviders } from "@/lib/store";
import { PRESETS } from "@/lib/presets";
import { InputError, keyHint, deleteConnection, reorderProviders, setEnabled, upsertConnection, type ConnectionInput } from "@/lib/connections";
import type { PublicProvider } from "@/lib/types";
import { scoped } from "@/lib/auth";

export const dynamic = "force-dynamic";

// LLM-provider view of the unified connections API (/api/connections), kept for existing callers.

function publicList(): PublicProvider[] {
  const limits = getLimits();
  return getProviders().map(({ apiKey, headers, ...p }) => ({
    ...p,
    headers: headers ? Object.fromEntries(Object.keys(headers).map((k) => [k, "••••"])) : undefined,
    keyHint: keyHint(apiKey),
    limits: limits[p.id] ?? { throttles: 0 },
  }));
}

const fail = (e: unknown) => Response.json({ error: e instanceof InputError ? e.message : "Couldn't save the provider.", providers: publicList() }, { status: e instanceof InputError ? 400 : 500 });

async function handleGET() {
  return Response.json({ providers: publicList(), presets: PRESETS });
}

/** Upsert. Omitting apiKey on an existing provider keeps the stored key. */
async function handlePOST(req: Request) {
  try {
    const body = (await req.json()) as Omit<ConnectionInput, "type"> & { kind?: string };
    if (body.id && Object.keys(body).every((k) => k === "id" || k === "enabled")) setEnabled("llm", body.id, !!body.enabled);
    else upsertConnection({ ...body, type: "llm", preset: body.preset ?? body.kind });
    return Response.json({ providers: publicList() });
  } catch (e) {
    return fail(e);
  }
}

/** Reorder: body { order: string[] } */
async function handlePUT(req: Request) {
  try {
    const { order } = (await req.json()) as { order: string[] };
    reorderProviders(Array.isArray(order) ? order.map(String) : []);
    return Response.json({ providers: publicList() });
  } catch (e) {
    return fail(e);
  }
}

async function handleDELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) deleteConnection("llm", id);
  return Response.json({ providers: publicList() });
}

// Every handler runs as the signed-in account, so all storage it touches is that account's (lib/store userHome()).
export const GET = scoped(handleGET);
export const POST = scoped(handlePOST);
export const PUT = scoped(handlePUT);
export const DELETE = scoped(handleDELETE);
