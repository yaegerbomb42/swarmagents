/**
 * Provider API Key Prefix Detection & Hints.
 * Analyzes pasted keys to automatically identify the matching provider preset,
 * along with instructions and deep links to obtain API keys.
 */

export interface KeyPattern {
  preset: string;
  kind: string;
  label: string;
  prefix: string | RegExp;
  hint: string;
  keyUrl: string;
}

export const KEY_PATTERNS: KeyPattern[] = [
  // Specific prefixes first before generic ones
  {
    preset: "anthropic",
    kind: "anthropic",
    label: "Anthropic",
    prefix: /^sk-ant-[A-Za-z0-9_-]{20,}/,
    hint: "Found under Settings -> API Keys in the Anthropic Console.",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    preset: "openrouter",
    kind: "openrouter",
    label: "OpenRouter",
    prefix: /^sk-or-v1-[a-f0-9]{30,}/,
    hint: "Create a new key on OpenRouter with custom model routing.",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    preset: "deepseek",
    kind: "deepseek",
    label: "DeepSeek",
    prefix: /^sk-[a-f0-9]{32}$/,
    hint: "Available in your DeepSeek Open Platform API keys section.",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    preset: "openai",
    kind: "openai",
    label: "OpenAI",
    prefix: /^sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
    hint: "Found under API Keys in the OpenAI developer platform.",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    preset: "gemini",
    kind: "gemini",
    label: "Google Gemini",
    prefix: /^AIza[0-9A-Za-z_-]{30,}/,
    hint: "Get your free or pay-as-you-go key in Google AI Studio.",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    preset: "groq",
    kind: "groq",
    label: "Groq",
    prefix: /^gsk_[A-Za-z0-9]{30,}/,
    hint: "Manage ultra-fast inference keys in Groq Console.",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    preset: "xai",
    kind: "xai",
    label: "xAI Grok",
    prefix: /^xai-[A-Za-z0-9]{30,}/,
    hint: "Generate Grok API keys in the xAI developer console.",
    keyUrl: "https://console.x.ai",
  },
  {
    preset: "mistral",
    kind: "mistral",
    label: "Mistral",
    prefix: /^[A-Za-z0-9]{32}$/, // Typical 32 hex/alphanumeric
    hint: "Create an API key in the Mistral La Plateforme dashboard.",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    preset: "cerebras",
    kind: "cerebras",
    label: "Cerebras",
    prefix: /^csk-[A-Za-z0-9]{30,}/,
    hint: "Generate inference API keys in Cerebras Cloud.",
    keyUrl: "https://cloud.cerebras.ai/platform",
  },
  {
    preset: "together",
    kind: "together",
    label: "Together AI",
    prefix: /^[a-f0-9]{64}$/,
    hint: "64-character token from Together AI settings.",
    keyUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    preset: "fireworks",
    kind: "fireworks",
    label: "Fireworks",
    prefix: /^fw_[A-Za-z0-9]{30,}/,
    hint: "Obtained from Fireworks AI user account settings.",
    keyUrl: "https://fireworks.ai/settings/users/api-keys",
  },
  {
    preset: "cohere",
    kind: "cohere",
    label: "Cohere",
    prefix: /^[A-Za-z0-9_-]{40}$/,
    hint: "Generated in the Cohere dashboard API keys page.",
    keyUrl: "https://dashboard.cohere.com/api-keys",
  },
  {
    preset: "perplexity",
    kind: "perplexity",
    label: "Perplexity",
    prefix: /^pplx-[a-f0-9]{40,}/,
    hint: "Found under API settings in your Perplexity account.",
    keyUrl: "https://www.perplexity.ai/account/api/keys",
  },
  {
    preset: "github",
    kind: "github",
    label: "GitHub Models",
    prefix: /^(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/,
    hint: "Personal Access Token (classic or fine-grained) with access to GitHub Models.",
    keyUrl: "https://github.com/settings/personal-access-tokens",
  },
  {
    preset: "huggingface",
    kind: "huggingface",
    label: "Hugging Face",
    prefix: /^hf_[A-Za-z0-9]{30,}/,
    hint: "User Access Token created in Hugging Face settings.",
    keyUrl: "https://huggingface.co/settings/tokens",
  },
];

/**
 * Detect matching provider preset and metadata from an API key prefix or format.
 */
export function detectProviderFromKey(key: string): KeyPattern | undefined {
  const trimmed = key.trim();
  if (!trimmed) return undefined;

  for (const pattern of KEY_PATTERNS) {
    if (typeof pattern.prefix === "string") {
      if (trimmed.startsWith(pattern.prefix)) return pattern;
    } else if (pattern.prefix instanceof RegExp) {
      if (pattern.prefix.test(trimmed)) return pattern;
    }
  }

  return undefined;
}

/**
 * Safely mask an API key or secret for UI display or transmission.
 * Returns only the last 4 characters preceded by bullets, or empty string if empty.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "";
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "••••";
  const tail = trimmed.slice(-4);
  return `••••${tail}`;
}
