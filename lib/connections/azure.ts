import type { ProviderConfig } from "../types";
import { validateSsrfUrl } from "./ssrf";
import { mapProviderError, type FriendlyError } from "./capabilities";

/**
 * Enterprise Azure OpenAI Connection & Validation Engine.
 * Supports:
 * - Resource name + Deployment name mapping
 * - Custom Azure base URLs (custom domains, API management gateways, private endpoints)
 * - API Versioning (e.g. 2024-02-15-preview, 2024-06-01, 2024-10-21)
 * - Microsoft Entra ID (Bearer token) or Azure api-key header authentication
 * - Comprehensive capability detection: completions, streaming, tool/function calling
 */

export interface AzureEndpointInput {
  resourceName?: string;
  deploymentName: string;
  apiVersion?: string;
  customBaseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  allowLocalhost?: boolean;
}

export interface AzureValidationResult {
  ok: boolean;
  message: string;
  normalizedConfig?: ProviderConfig;
  error?: FriendlyError;
  latencyMs?: number;
  capabilities?: {
    streaming: boolean;
    tools: boolean;
  };
}

export function constructAzureUrl(input: AzureEndpointInput): string {
  const version = input.apiVersion || "2024-02-15-preview";
  if (input.customBaseUrl?.trim()) {
    const base = input.customBaseUrl.trim().replace(/\/+$/, "");
    if (base.includes("/deployments/")) {
      return base.includes("api-version=") ? base : `${base}${base.includes("?") ? "&" : "?"}api-version=${version}`;
    }
    return `${base}/openai/deployments/${encodeURIComponent(input.deploymentName)}/chat/completions?api-version=${version}`;
  }

  const resource = input.resourceName?.trim() || "my-resource";
  return `https://${encodeURIComponent(resource)}.openai.azure.com/openai/deployments/${encodeURIComponent(input.deploymentName)}/chat/completions?api-version=${version}`;
}

export async function validateAzureEndpoint(input: AzureEndpointInput): Promise<AzureValidationResult> {
  const start = Date.now();
  if (!input.deploymentName?.trim()) {
    return {
      ok: false,
      message: "Deployment name is required for Azure OpenAI.",
      error: {
        type: "bad_url",
        message: "Missing Azure deployment name.",
        suggestedFix: "Enter the model deployment name configured in Azure AI Foundry / Azure OpenAI Studio.",
      },
    };
  }

  const targetUrl = constructAzureUrl(input);

  // SSRF Protection
  const ssrf = await validateSsrfUrl(targetUrl, { allowLocalhost: input.allowLocalhost ?? false });
  if (!ssrf.allowed) {
    return {
      ok: false,
      message: ssrf.reason || "Azure endpoint URL failed security check.",
      error: {
        type: "ssrf_blocked",
        message: ssrf.reason || "Destination IP or host is restricted.",
        suggestedFix: "Verify that the Azure resource name or custom base URL is accurate and points to Azure cloud.",
      },
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (input.bearerToken?.trim()) {
    headers["Authorization"] = `Bearer ${input.bearerToken.trim()}`;
  } else if (input.apiKey?.trim()) {
    headers["api-key"] = input.apiKey.trim();
  } else {
    return {
      ok: false,
      message: "An Azure API Key or Microsoft Entra Bearer token is required.",
      error: {
        type: "wrong_key",
        message: "Authentication credential missing.",
        suggestedFix: "Provide your Azure API key or Microsoft Entra ID token from Azure Portal.",
      },
    };
  }

  let streamingSupported = false;
  let toolsSupported = false;

  // 1. Probe basic completion & streaming
  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 2,
        stream: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      const friendly = mapProviderError(res.status, errText, targetUrl);
      return {
        ok: false,
        message: `${friendly.message} (${friendly.suggestedFix})`,
        error: friendly,
        latencyMs: Date.now() - start,
      };
    }

    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      streamingSupported = true;
    }
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    const friendly = mapProviderError(undefined, msg, targetUrl);
    return {
      ok: false,
      message: `${friendly.message} (${friendly.suggestedFix})`,
      error: friendly,
      latencyMs: Date.now() - start,
    };
  }

  // 2. Probe tool calling support
  try {
    const toolRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: "What is the time?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "check_time",
              description: "Checks time",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (toolRes.ok) {
      const toolData = (await toolRes.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
      if (toolData.choices?.[0]?.message) {
        toolsSupported = true;
      }
    }
  } catch {}

  const latencyMs = Date.now() - start;

  const normalizedConfig: ProviderConfig = {
    id: `azure_${Date.now()}`,
    kind: "azure",
    preset: "azure",
    label: `Azure (${input.deploymentName})`,
    baseUrl: targetUrl.split("/chat/completions")[0],
    apiKey: input.apiKey || "",
    model: input.deploymentName,
    headers: {
      ...(input.apiKey ? { "api-key": "{key}" } : {}),
      ...(input.bearerToken ? { Authorization: `Bearer ${input.bearerToken}` } : {}),
      "api-version": input.apiVersion || "2024-02-15-preview",
    },
    enabled: true,
  };

  return {
    ok: true,
    message: `Azure OpenAI verified · Deployment '${input.deploymentName}' responded · Latency ${latencyMs}ms`,
    latencyMs,
    capabilities: {
      streaming: streamingSupported,
      tools: toolsSupported,
    },
    normalizedConfig,
  };
}
