import type { CapabilityEntry } from "../schema";
import { truncateSummary } from "../schema";

export interface ProviderSpec {
  id: string;
  name: string;
  envVars: string[];
  modelsUrl: string;
  authHeader: (key: string) => Record<string, string>;
}

export const AI_PROVIDERS: ProviderSpec[] = [
  {
    id: "openai",
    name: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    modelsUrl: "https://api.openai.com/v1/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    modelsUrl: "https://api.anthropic.com/v1/models",
    authHeader: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
  },
  {
    id: "gemini",
    name: "Google Gemini",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    authHeader: (k) => ({ "x-goog-api-key": k }),
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    modelsUrl: "https://openrouter.ai/api/v1/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    id: "groq",
    name: "Groq",
    envVars: ["GROQ_API_KEY"],
    modelsUrl: "https://api.groq.com/openai/v1/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    id: "mistral",
    name: "Mistral",
    envVars: ["MISTRAL_API_KEY"],
    modelsUrl: "https://api.mistral.ai/v1/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    envVars: ["NVIDIA_API_KEY"],
    modelsUrl: "https://integrate.api.nvidia.com/v1/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    modelsUrl: "https://api.deepseek.com/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    id: "together",
    name: "Together AI",
    envVars: ["TOGETHER_API_KEY"],
    modelsUrl: "https://api.together.xyz/v1/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    id: "xai",
    name: "xAI",
    envVars: ["XAI_API_KEY"],
    modelsUrl: "https://api.x.ai/v1/models",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
];

export interface ProviderScanOptions {
  verify?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

async function verifyProvider(
  spec: ProviderSpec,
  envVarName: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<"ok" | "failed"> {
  const key = env[envVarName];
  if (!key) return "failed";
  try {
    const res = await fetch(spec.modelsUrl, {
      method: "GET",
      headers: spec.authHeader(key),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

export async function scanAiProviders(
  options: ProviderScanOptions = {}
): Promise<CapabilityEntry[]> {
  const env = options.env ?? process.env;
  const verify = options.verify ?? false;
  const timeoutMs = options.timeoutMs ?? 5000;

  const entries: CapabilityEntry[] = [];

  for (const spec of AI_PROVIDERS) {
    const matchedVar = spec.envVars.find(
      (v) => typeof env[v] === "string" && env[v]!.trim().length > 0
    );
    if (!matchedVar) continue;

    let status: "configured" | "ok" | "failed" = "configured";
    if (verify) {
      status = await verifyProvider(spec, matchedVar, env, timeoutMs);
    }

    entries.push({
      id: `provider:${spec.id}`,
      kind: "ai_provider",
      name: spec.name,
      summary: truncateSummary(
        `${spec.name} API key configured via ${matchedVar} (${status})`
      ),
      risk: "network",
      schema: {
        envVar: matchedVar,
        status,
        modelsEndpoint: spec.modelsUrl,
      },
      source: `env:${matchedVar}`,
    });
  }

  return entries;
}
