import { getProviders } from "@/lib/store";
import { PARALLEL_MAX, PARALLEL_MIN, SUBAGENT_DEFAULTS, SubagentSettingsError, getSubagentSettings, saveSubagentSettings, type SubagentSettings } from "@/lib/subagent-settings";

export const dynamic = "force-dynamic";

// Sub-agent preferences (SA3). Behind the same auth gate as every other /api route (middleware.ts).

function body() {
  const providers = getProviders().map((p) => ({ id: p.id, label: p.label, model: p.model, enabled: p.enabled, models: p.models ?? [] }));
  return { settings: getSubagentSettings(), defaults: SUBAGENT_DEFAULTS, limits: { parallelMin: PARALLEL_MIN, parallelMax: PARALLEL_MAX }, providers };
}

export async function GET() {
  return Response.json(body());
}

export async function PUT(req: Request) {
  const patch = (await req.json().catch(() => null)) as Partial<SubagentSettings> | null;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return Response.json({ error: "Send a JSON object." }, { status: 400 });
  const allowed = new Set(Object.keys(SUBAGENT_DEFAULTS));
  const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
  if (unknown.length) return Response.json({ error: `Unknown setting: ${unknown.join(", ")}` }, { status: 400 });
  try {
    saveSubagentSettings(patch);
    return Response.json(body());
  } catch (e) {
    if (e instanceof SubagentSettingsError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
