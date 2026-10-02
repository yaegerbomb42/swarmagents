import { validateAndConfigureCustomEndpoint, type CustomEndpointInput } from "@/lib/connections/custom-endpoint";
import { checkConnectionHealth } from "@/lib/connections/health";
import { detectProviderFromKey } from "@/lib/connections/key-detect";
import type { ProviderConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Diagnostic & Validation API for Connections.
 * Handles:
 * - BYOK / custom endpoint discovery & validation with SSRF blocking
 * - Live connection health & feature probe
 * - Key prefix detection & recommendations
 */
export async function POST(req: Request) {
  let body: {
    action: "validate_endpoint" | "detect_key" | "health_check";
    endpoint?: CustomEndpointInput;
    key?: string;
    provider?: ProviderConfig;
    allowLocalhost?: boolean;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action === "detect_key") {
    if (!body.key) return Response.json({ ok: false, message: "Missing key" }, { status: 400 });
    const detected = detectProviderFromKey(body.key);
    return Response.json({ ok: true, detected: detected ?? null });
  }

  if (body.action === "validate_endpoint") {
    if (!body.endpoint) return Response.json({ ok: false, message: "Missing endpoint specification" }, { status: 400 });
    const res = await validateAndConfigureCustomEndpoint(body.endpoint);
    return Response.json(res);
  }

  if (body.action === "health_check") {
    if (!body.provider) return Response.json({ ok: false, message: "Missing provider configuration" }, { status: 400 });
    const health = await checkConnectionHealth(body.provider, body.allowLocalhost ?? false);
    return Response.json({ ok: true, health });
  }

  return Response.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
