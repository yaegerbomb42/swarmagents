import type { ProviderConfig } from "../types";
import { validateSsrfUrl } from "./ssrf";
import { probeCapabilities, type EndpointCapabilities, type FriendlyError } from "./capabilities";
import { mapProviderError } from "./capabilities";

/**
 * Custom & BYOK Endpoint Handler.
 * Supports:
 * - OpenAI-compatible base URLs (Ollama, LM Studio, vLLM, LiteLLM, Azure OpenAI, self-hosted)
 * - Anthropic-compatible endpoints
 * - Custom headers and Azure API version parameter
 * - Automatic model discovery via /v1/models with manual model fallback
 * - Streaming, tool-calling, and vision capability detection
 * - SSRF protection with opt-in for self-hosted localhost
 */

export interface CustomEndpointInput {
  kind: "openai" | "anthropic" | "azure" | "ollama" | "lmstudio" | "vllm" | "litellm" | "custom";
  label?: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  apiVersion?: string; // For Azure OpenAI (e.g. 2024-02-15-preview)
  customHeaders?: Record<string, string>;
  allowLocalhost?: boolean;
}

export interface EndpointValidationResult {
  ok: boolean;
  message: string;
  capabilities?: EndpointCapabilities;
  error?: FriendlyError;
  normalizedConfig?: ProviderConfig;
}

export async function validateAndConfigureCustomEndpoint(input: CustomEndpointInput): Promise<EndpointValidationResult> {
  const normUrl = input.baseUrl.trim();
  if (!normUrl) {
    return { ok: false, message: "Base URL is required." };
  }

  // 1. SSRF Safety Verification
  const ssrf = await validateSsrfUrl(normUrl, { allowLocalhost: input.allowLocalhost ?? false });
  if (!ssrf.allowed) {
    return {
      ok: false,
      message: ssrf.reason || "Endpoint URL is blocked by security policy.",
      error: {
        type: "ssrf_blocked",
        message: ssrf.reason || "Destination IP or hostname is restricted.",
        suggestedFix: "Ensure the URL points to a public host or enable self-hosted local access.",
      },
    };
  }

  // 2. Prepare headers (including Azure API version if specified)
  const headers: Record<string, string> = { ...(input.customHeaders ?? {}) };
  if (input.kind === "azure" || input.apiVersion) {
    if (input.apiVersion) {
      headers["api-version"] = input.apiVersion;
    }
  }

  const isAnthropicProtocol = input.kind === "anthropic";

  const config: ProviderConfig = {
    id: `custom_${Date.now()}`,
    kind: isAnthropicProtocol ? "anthropic" : "openai",
    preset: input.kind,
    label: input.label || `Custom (${new URL(normUrl).hostname})`,
    baseUrl: normUrl,
    apiKey: input.apiKey || "",
    model: input.model || "",
    headers,
    enabled: true,
  };

  // 3. Probe capabilities
  try {
    const caps = await probeCapabilities(config);
    return {
      ok: true,
      message: `Endpoint verified · ${caps.discoveredModels.length} models discovered · Latency ${caps.latencyMs}ms`,
      capabilities: caps,
      normalizedConfig: {
        ...config,
        model: config.model || caps.discoveredModels[0] || "",
      },
    };
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    const status = (err as { status?: number }).status;
    const friendly = mapProviderError(status, msg, normUrl);

    return {
      ok: false,
      message: `${friendly.message} (${friendly.suggestedFix})`,
      error: friendly,
    };
  }
}
