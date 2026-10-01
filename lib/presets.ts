import type { ProviderKind } from "./types";

export interface Preset {
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  /** Default model; empty means "first model the provider lists". */
  model: string;
  keyUrl?: string;
  needsKey: boolean;
  /** One-click account connection (OAuth) instead of pasting a key. */
  oauth?: boolean;
  group: "Connect" | "Major labs" | "Fast inference" | "Aggregators & hosts" | "Local" | "Custom";
}

// Every provider here except Anthropic speaks the OpenAI-compatible chat API, so adding one is a single line.
// The settings UI fetches each provider's live model list, so defaults only matter until then.
export const PRESETS: Preset[] = [
  { group: "Connect", kind: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-opus-5.5", keyUrl: "https://openrouter.ai/keys", needsKey: true, oauth: true },

  { group: "Major labs", kind: "anthropic", label: "Anthropic", model: "claude-opus-5-5", keyUrl: "https://console.anthropic.com/settings/keys", needsKey: true },
  { group: "Major labs", kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5", keyUrl: "https://platform.openai.com/api-keys", needsKey: true },
  { group: "Major labs", kind: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro", keyUrl: "https://aistudio.google.com/apikey", needsKey: true },
  { group: "Major labs", kind: "xai", label: "xAI Grok", baseUrl: "https://api.x.ai/v1", model: "grok-4", keyUrl: "https://console.x.ai", needsKey: true },
  { group: "Major labs", kind: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest", keyUrl: "https://console.mistral.ai/api-keys", needsKey: true },
  { group: "Major labs", kind: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", needsKey: true },
  { group: "Major labs", kind: "moonshot", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.ai/v1", model: "", keyUrl: "https://platform.moonshot.ai/console/api-keys", needsKey: true },
  { group: "Major labs", kind: "qwen", label: "Alibaba Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-max", keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key", needsKey: true },
  { group: "Major labs", kind: "zhipu", label: "Zhipu GLM", baseUrl: "https://api.z.ai/api/paas/v4", model: "", keyUrl: "https://z.ai/manage-apikey/apikey-list", needsKey: true },
  { group: "Major labs", kind: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", model: "", keyUrl: "https://www.minimax.io/platform/user-center/basic-information/interface-key", needsKey: true },
  { group: "Major labs", kind: "cohere", label: "Cohere", baseUrl: "https://api.cohere.ai/compatibility/v1", model: "command-a-03-2025", keyUrl: "https://dashboard.cohere.com/api-keys", needsKey: true },
  { group: "Major labs", kind: "perplexity", label: "Perplexity", baseUrl: "https://api.perplexity.ai", model: "sonar-pro", keyUrl: "https://www.perplexity.ai/account/api/keys", needsKey: true },

  { group: "Fast inference", kind: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", keyUrl: "https://console.groq.com/keys", needsKey: true },
  { group: "Fast inference", kind: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "", keyUrl: "https://cloud.cerebras.ai/platform", needsKey: true },
  { group: "Fast inference", kind: "sambanova", label: "SambaNova", baseUrl: "https://api.sambanova.ai/v1", model: "", keyUrl: "https://cloud.sambanova.ai/apis", needsKey: true },

  { group: "Aggregators & hosts", kind: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", model: "", keyUrl: "https://api.together.ai/settings/api-keys", needsKey: true },
  { group: "Aggregators & hosts", kind: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", model: "", keyUrl: "https://fireworks.ai/settings/users/api-keys", needsKey: true },
  { group: "Aggregators & hosts", kind: "deepinfra", label: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", model: "", keyUrl: "https://deepinfra.com/dash/api_keys", needsKey: true },
  { group: "Aggregators & hosts", kind: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", model: "", keyUrl: "https://huggingface.co/settings/tokens", needsKey: true },
  { group: "Aggregators & hosts", kind: "github", label: "GitHub Models", baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4.1", keyUrl: "https://github.com/settings/personal-access-tokens", needsKey: true },
  { group: "Aggregators & hosts", kind: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", model: "", keyUrl: "https://build.nvidia.com/settings/api-keys", needsKey: true },
  { group: "Aggregators & hosts", kind: "vercel", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", model: "", keyUrl: "https://vercel.com/dashboard/ai-gateway/api-keys", needsKey: true },
  { group: "Aggregators & hosts", kind: "nebius", label: "Nebius", baseUrl: "https://api.studio.nebius.com/v1", model: "", keyUrl: "https://studio.nebius.com/settings/api-keys", needsKey: true },
  { group: "Aggregators & hosts", kind: "novita", label: "Novita", baseUrl: "https://api.novita.ai/v3/openai", model: "", keyUrl: "https://novita.ai/settings/key-management", needsKey: true },
  { group: "Aggregators & hosts", kind: "hyperbolic", label: "Hyperbolic", baseUrl: "https://api.hyperbolic.xyz/v1", model: "", keyUrl: "https://app.hyperbolic.xyz/settings", needsKey: true },

  { group: "Local", kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "", needsKey: false },
  { group: "Local", kind: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", model: "", needsKey: false },
  { group: "Local", kind: "litellm", label: "LiteLLM proxy", baseUrl: "http://127.0.0.1:4000/v1", model: "", needsKey: false },

  { group: "Custom", kind: "custom", label: "Custom endpoint", baseUrl: "", model: "", needsKey: false },
];

export const presetFor = (kind: ProviderKind) => PRESETS.find((p) => p.kind === kind) ?? PRESETS.at(-1)!;
