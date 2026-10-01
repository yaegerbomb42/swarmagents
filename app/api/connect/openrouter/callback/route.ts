import { getProviders, newId, saveProviders } from "@/lib/store";
import { presetFor } from "@/lib/presets";
import { verifiers } from "@/lib/oauth";
import { redirectTo } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const verifier = u.searchParams.get("v") ?? "";
  const back = (q: string) => redirectTo(`/?${q}`);
  if (!code || !verifiers.has(verifier)) return back("connect_error=openrouter");
  verifiers.delete(verifier);
  let r: Response;
  try {
    r = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const why = (e as Error).name === "TimeoutError" ? "OpenRouter didn't answer within 20s" : "Couldn't reach OpenRouter";
    return back(`connect_error=${encodeURIComponent(`${why}. Try again or paste a key.`)}`);
  }
  const d = (await r.json().catch(() => ({}))) as { key?: string; error?: { message?: string } | string };
  if (!r.ok || !d.key) {
    const msg = typeof d.error === "string" ? d.error : d.error?.message;
    return back(msg ? `connect_error=${encodeURIComponent(`OpenRouter: ${msg.slice(0, 160)}`)}` : "connect_error=openrouter");
  }
  const preset = presetFor("openrouter");
  const list = getProviders();
  const existing = list.find((p) => p.kind === "openrouter");
  if (existing) existing.apiKey = d.key;
  else list.push({ id: newId(), kind: "openrouter", preset: preset.id, label: preset.label, apiKey: d.key, baseUrl: preset.baseUrl, model: preset.model, enabled: true });
  saveProviders(list);
  return back("connected=openrouter");
}
