import { getLimits, getProviders, newId, saveProviders } from "@/lib/store";
import { PRESETS, presetFor } from "@/lib/presets";
import type { ProviderConfig, PublicProvider } from "@/lib/types";

export const dynamic = "force-dynamic";

function publicList(): PublicProvider[] {
  const limits = getLimits();
  return getProviders().map(({ apiKey, ...p }) => ({ ...p, keyHint: apiKey ? `…${apiKey.slice(-4)}` : "", limits: limits[p.id] ?? { throttles: 0 } }));
}

export async function GET() {
  return Response.json({ providers: publicList(), presets: PRESETS });
}

/** Upsert. Omitting apiKey on an existing provider keeps the stored key. */
export async function POST(req: Request) {
  const body = (await req.json()) as Partial<ProviderConfig>;
  const list = getProviders();
  const existing = body.id ? list.find((p) => p.id === body.id) : undefined;
  if (existing) Object.assign(existing, { ...body, apiKey: body.apiKey || existing.apiKey });
  else {
    const preset = presetFor(body.kind ?? "custom");
    list.push({
      id: newId(),
      kind: preset.kind,
      label: body.label || preset.label,
      apiKey: body.apiKey ?? "",
      baseUrl: body.baseUrl ?? preset.baseUrl,
      model: body.model || preset.model,
      enabled: true,
    });
  }
  saveProviders(list);
  return Response.json({ providers: publicList() });
}

/** Reorder: body { order: string[] } */
export async function PUT(req: Request) {
  const { order } = (await req.json()) as { order: string[] };
  const list = getProviders();
  list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveProviders(list);
  return Response.json({ providers: publicList() });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  saveProviders(getProviders().filter((p) => p.id !== id));
  return Response.json({ providers: publicList() });
}
