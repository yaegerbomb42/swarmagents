import { testProvider } from "../providers/index";
import { getProviders, saveProviders } from "../store";
import type { ProviderConfig } from "../types";
import { validateSsrfUrl } from "./ssrf";
import { mapProviderError, type FriendlyError } from "./capabilities";

/**
 * Live Health Check & Latency Monitor for Connections.
 */

export interface ConnectionHealth {
  id: string;
  ok: boolean;
  latencyMs: number;
  lastChecked: number;
  error?: FriendlyError;
  features?: {
    streaming?: boolean;
    tools?: boolean;
    vision?: boolean;
  };
}

export async function checkConnectionHealth(provider: ProviderConfig, allowLocalhost = false): Promise<ConnectionHealth> {
  const start = Date.now();

  // SSRF check first if custom baseUrl is provided
  if (provider.baseUrl) {
    const ssrf = await validateSsrfUrl(provider.baseUrl, { allowLocalhost });
    if (!ssrf.allowed) {
      return {
        id: provider.id,
        ok: false,
        latencyMs: 0,
        lastChecked: Date.now(),
        error: {
          type: "ssrf_blocked",
          message: ssrf.reason || "Destination IP or host is blocked.",
          suggestedFix: "Change the URL or enable localhost access if hosting locally.",
        },
      };
    }
  }

  try {
    const result = await testProvider(provider);
    const latencyMs = Date.now() - start;

    return {
      id: provider.id,
      ok: true,
      latencyMs,
      lastChecked: Date.now(),
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const msg = (err as Error).message || String(err);
    const status = (err as { status?: number }).status;
    const friendly = mapProviderError(status, msg, provider.baseUrl || "");

    return {
      id: provider.id,
      ok: false,
      latencyMs,
      lastChecked: Date.now(),
      error: friendly,
    };
  }
}
