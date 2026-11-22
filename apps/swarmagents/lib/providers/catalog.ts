/**
 * LLM provider catalog: one typed entry per well-known provider.
 *
 * This is pure, dependency-free data — safe to import from client components
 * (unlike ./types or ./router, which are server-only). It feeds both the
 * providers UI (cards, pre-filled add form) and the server (GET /api/providers
 * and the POST validation via providerKindForCatalog).
 *
 * Link policy: every URL must be a real official page. When in doubt, omit the
 * link — a missing link beats a guessed one. baseUrl is omitted for providers
 * whose API root depends on account/region details.
 */

import { MORE_PROVIDER_CATALOG } from "./catalog-more";

export type CatalogApiStyle =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "ollama"
  /** Legacy aliases still accepted from older clients/config files. */
  | "openai-compatible"
  | "custom";

export type CatalogAuthHeader = "bearer" | "x-api-key" | "x-goog-api-key" | "none" | "custom";

/** Normalize any accepted catalog/API style to a canonical wire style. */
export function normalizeCatalogApiStyle(value: unknown): Exclude<CatalogApiStyle, "openai-compatible" | "custom"> | undefined {
  switch (value) {
    case "openai-chat":
    case "openai-compatible":
    case "custom":
      return "openai-chat";
    case "openai-responses":
    case "anthropic":
    case "gemini":
    case "ollama":
      return value;
    default:
      return undefined;
  }
}

export interface ProviderCatalogLinks {
  /** New-account / sign-up page (or the product homepage when that is the console). */
  signup?: string;
  /** Console / dashboard. */
  console?: string;
  /** API-key management page. */
  apiKeys?: string;
  /** Official API documentation. */
  docs?: string;
  /** Pricing page. */
  pricing?: string;
}

export interface ProviderCatalogEntry {
  /** Stable identifier; also the server-side provider config id. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description shown on the card. */
  shortDescription: string;
  /** Wire-format style. */
  apiStyle: CatalogApiStyle;
  /** API root. Omitted when it depends on account/region specifics. */
  baseUrl?: string;
  /** Model suggestions: default + popular alternatives. */
  models?: {
    default?: string;
    popular: string[];
  };
  /** How the provider expects the key on requests. */
  authHeader: CatalogAuthHeader;
  /** Environment variable this platform reads for the key (SWARM_KEYS_<ID>). */
  envVar: string;
  /** The provider's own conventional env var name, for display only. */
  standardEnvVar?: string;
  links: ProviderCatalogLinks;
  /** True for local-only endpoints (http://localhost, no key required). */
  isLocal?: boolean;
  /**
   * True when the provider has a genuinely free tier (no card required, or a
   * local server that costs $0 to run). Drives the saved-config default:
   * store.saveProvider and routerProviders seed ProviderConfig.isFree from
   * this when the user has not set their own billing flag, which in turn
   * makes cost estimates read $0 and enables prefer-free routing. Only set
   * where the free tier is verified — a trial credit or an eval-only key
   * does not count.
   */
  isFree?: boolean;
  /** Short hint shown in the UI for providers needing special auth/setup. */
  authHint?: string;
  /** Default credential placement, when it differs from the generic auth style. */
  auth?: { scheme: "none" | "bearer" | "x-api-key" | "x-goog-api-key" | "custom-header" | "basic"; headerName?: string };
}

/** The server's wire kinds. Every style maps onto one of them. */
export type CatalogProviderKind = "anthropic" | "openai" | "gemini";

export function providerKindForCatalog(entry: Pick<ProviderCatalogEntry, "apiStyle">): CatalogProviderKind {
  if (entry.apiStyle === "anthropic") return "anthropic";
  if (entry.apiStyle === "gemini") return "gemini";
  return "openai";
}

const CHEVRON = "·";

/** Stable color per provider (initial badge). Derives a hue from the id. */
export function providerHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) % 360;
  }
  return hash;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    shortDescription: "Claude frontier models via the native Anthropic API.",
    apiStyle: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: {
      default: "claude-sonnet-4-5",
      popular: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"],
    },
    authHeader: "x-api-key",
    envVar: "SWARM_KEYS_ANTHROPIC",
    standardEnvVar: "ANTHROPIC_API_KEY",
    links: {
      console: "https://console.anthropic.com",
      apiKeys: "https://console.anthropic.com/settings/keys",
      docs: "https://docs.anthropic.com",
      pricing: "https://www.anthropic.com/pricing",
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    shortDescription: "GPT models via the OpenAI platform API.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    models: {
      default: "gpt-4.1",
      popular: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini", "o3"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_OPENAI",
    standardEnvVar: "OPENAI_API_KEY",
    links: {
      console: "https://platform.openai.com",
      apiKeys: "https://platform.openai.com/api-keys",
      docs: "https://platform.openai.com/docs",
      pricing: "https://platform.openai.com/docs/pricing",
    },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    shortDescription: "Gemini models via Google AI Studio / the Gemini API.",
    apiStyle: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: {
      default: "gemini-2.5-pro",
      popular: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    },
    authHeader: "x-goog-api-key",
    envVar: "SWARM_KEYS_GEMINI",
    standardEnvVar: "GEMINI_API_KEY",
    links: {
      console: "https://aistudio.google.com",
      apiKeys: "https://aistudio.google.com/app/apikey",
      docs: "https://ai.google.dev/gemini-api/docs",
      pricing: "https://ai.google.dev/gemini-api/docs/pricing",
    },
    // Gemini API has a free tier (rate-limited) in Google AI Studio.
    isFree: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    shortDescription: "Mistral and Codestral models via the Mistral platform.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.mistral.ai/v1",
    models: {
      default: "mistral-large-latest",
      popular: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "codestral-latest"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_MISTRAL",
    standardEnvVar: "MISTRAL_API_KEY",
    links: {
      console: "https://console.mistral.ai",
      apiKeys: "https://console.mistral.ai/api-keys/",
      docs: "https://docs.mistral.ai",
      pricing: "https://mistral.ai/pricing",
    },
    // La Plateforme's Experiment plan is free (rate-limited).
    isFree: true,
  },
  {
    id: "groq",
    name: "Groq",
    shortDescription: "Ultra-fast open-weights models on Groq LPU hardware.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.groq.com/openai/v1",
    models: {
      default: "llama-3.3-70b-versatile",
      popular: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_GROQ",
    standardEnvVar: "GROQ_API_KEY",
    links: {
      console: "https://console.groq.com",
      apiKeys: "https://console.groq.com/keys",
      docs: "https://console.groq.com/docs",
      pricing: "https://groq.com/pricing",
    },
    // Free tier with no billing card (rate-limited).
    isFree: true,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    shortDescription: "Open-weights models served at hyperscale inference speed.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.cerebras.ai/v1",
    models: {
      default: "llama-3.3-70b",
      popular: ["llama-3.3-70b", "gpt-oss-120b", "llama-3.1-8b"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_CEREBRAS",
    standardEnvVar: "CEREBRAS_API_KEY",
    links: {
      console: "https://cloud.cerebras.ai",
      apiKeys: "https://cloud.cerebras.ai/api-keys",
      docs: "https://inference-docs.cerebras.ai",
      pricing: "https://www.cerebras.ai/pricing",
    },
    // Free tier with no card required (rate-limited).
    isFree: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shortDescription: "DeepSeek chat and reasoner models via the platform API.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    models: {
      default: "deepseek-chat",
      popular: ["deepseek-chat", "deepseek-reasoner"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_DEEPSEEK",
    standardEnvVar: "DEEPSEEK_API_KEY",
    links: {
      console: "https://platform.deepseek.com",
      apiKeys: "https://platform.deepseek.com/api_keys",
      docs: "https://api-docs.deepseek.com",
      pricing: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    shortDescription: "Grok models via the xAI console and API.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    models: {
      default: "grok-4",
      popular: ["grok-4", "grok-3", "grok-3-fast"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_XAI",
    standardEnvVar: "XAI_API_KEY",
    links: {
      console: "https://console.x.ai",
      apiKeys: "https://console.x.ai/api-keys",
      docs: "https://docs.x.ai",
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    shortDescription: "One key for hundreds of models across many providers.",
    apiStyle: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    models: {
      // OpenRouter slugs use dots, not dashes: anthropic/claude-sonnet-4.5.
      default: "anthropic/claude-sonnet-4.5",
      popular: [
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-4.1-mini",
        "meta-llama/llama-3.3-70b-instruct",
        "deepseek/deepseek-chat",
      ],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_OPENROUTER",
    standardEnvVar: "OPENROUTER_API_KEY",
    links: {
      console: "https://openrouter.ai",
      apiKeys: "https://openrouter.ai/keys",
      docs: "https://openrouter.ai/docs",
      pricing: "https://openrouter.ai/models",
    },
  },
  {
    id: "together",
    name: "Together AI",
    shortDescription: "Open models and inference infrastructure on Together's cloud.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.together.xyz/v1",
    models: {
      default: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      popular: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_TOGETHER",
    standardEnvVar: "TOGETHER_API_KEY",
    links: {
      console: "https://api.together.ai",
      apiKeys: "https://api.together.ai/settings/api-keys",
      docs: "https://docs.together.ai",
      pricing: "https://www.together.ai/pricing",
    },
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    shortDescription: "Fast inference for open models on Fireworks' serverless platform.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: {
      default: "accounts/fireworks/models/llama-v3p3-70b-instruct",
      popular: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/qwen3-32b"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_FIREWORKS",
    standardEnvVar: "FIREWORKS_API_KEY",
    links: {
      console: "https://app.fireworks.ai",
      apiKeys: "https://app.fireworks.ai/api-keys",
      docs: "https://docs.fireworks.ai",
      pricing: "https://fireworks.ai/pricing",
    },
  },
  {
    id: "perplexity",
    name: "Perplexity",
    shortDescription: "Sonar on the Agent API — search-grounded answers with citations.",
    // Agent API: POST /v1/agent (aliased as /v1/responses), OpenAI
    // Responses wire format. The legacy Sonar Chat Completions endpoint
    // retired 2026-09-27; the old sonar* ids are now effort levels
    // (fast/low/medium/high) of the single perplexity/sonar model.
    // requestUrl appends /v1/responses to this base.
    apiStyle: "openai-responses",
    baseUrl: "https://api.perplexity.ai",
    models: {
      default: "perplexity/sonar",
      popular: ["perplexity/sonar"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_PERPLEXITY",
    standardEnvVar: "PERPLEXITY_API_KEY",
    links: {
      console: "https://www.perplexity.ai/hub",
      apiKeys: "https://www.perplexity.ai/settings/api",
      docs: "https://docs.perplexity.ai",
    },
  },
  {
    id: "cohere",
    name: "Cohere",
    shortDescription: "Command models via Cohere's OpenAI-compatible v2 endpoint.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    models: {
      // Cohere ids are date-suffixed; the bare aliases were deprecated.
      default: "command-a-03-2025",
      popular: ["command-a-03-2025", "command-a-plus-05-2026", "command-r-plus-08-2024", "command-r-08-2024"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_COHERE",
    standardEnvVar: "COHERE_API_KEY",
    links: {
      console: "https://dashboard.cohere.com",
      apiKeys: "https://dashboard.cohere.com/api-keys",
      docs: "https://docs.cohere.com",
      pricing: "https://cohere.com/pricing",
    },
  },
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    shortDescription: "NVIDIA-hosted NIM endpoints (Llama, Nemotron, DeepSeek-R1).",
    apiStyle: "openai-chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    models: {
      default: "nvidia/nemotron-3.5-lightning-30b-a3b",
      popular: ["nvidia/nemotron-3.5-lightning-30b-a3b", "meta/llama-3.1-405b-instruct", "deepseek-ai/deepseek-r1"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_NVIDIA_NIM",
    standardEnvVar: "NVIDIA_API_KEY",
    links: {
      console: "https://build.nvidia.com",
      docs: "https://docs.nvidia.com/nim/",
    },
  },
  {
    id: "inception",
    name: "Inception (Mercury)",
    shortDescription: "Mercury diffusion models from Inception.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    models: {
      default: "mercury-3",
      popular: ["mercury-3"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_INCEPTION",
    standardEnvVar: "INCEPTION_API_KEY",
    links: {},
  },
  {
    id: "radium",
    name: "Radium",
    shortDescription: "Anthropic-compatible gateway (Mercury-class proxy endpoints).",
    apiStyle: "anthropic",
    models: {
      popular: [],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_RADIUM",
    standardEnvVar: "RADIUM_API_KEY",
    links: {},
  },
  {
    id: "sambanova",
    name: "SambaNova Cloud",
    shortDescription: "Open-weights models on SambaNova's fast cloud.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.sambanova.ai/v1",
    models: {
      default: "Meta-Llama-3.3-70B-Instruct",
      popular: ["Meta-Llama-3.3-70B-Instruct", "gpt-oss-120b"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_SAMBANOVA",
    standardEnvVar: "SAMBANOVA_API_KEY",
    links: {
      console: "https://cloud.sambanova.ai",
      docs: "https://docs.sambanova.ai",
    },
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    shortDescription: "Hugging Face Inference Providers unified router for open models.",
    apiStyle: "openai-chat",
    baseUrl: "https://router.huggingface.co/v1",
    models: {
      default: "meta-llama/Llama-3.3-70B-Instruct",
      popular: ["meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-R1"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_HUGGINGFACE",
    standardEnvVar: "HF_TOKEN",
    links: {
      console: "https://huggingface.co",
      apiKeys: "https://huggingface.co/settings/tokens",
      docs: "https://huggingface.co/docs/inference-providers",
      pricing: "https://huggingface.co/pricing",
    },
  },
  {
    id: "ollama",
    name: "Ollama",
    shortDescription: "Local open models via the native Ollama server (no key).",
    apiStyle: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    models: {
      default: "llama3.3",
      popular: ["llama3.3", "qwen2.5", "mistral"],
    },
    authHeader: "none",
    envVar: "SWARM_KEYS_OLLAMA",
    links: {
      console: "https://ollama.com",
      docs: "https://github.com/ollama/ollama",
    },
    isFree: true,
    isLocal: true,
    authHint: "Installed models are discovered automatically from /api/tags.",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    shortDescription: "Local OpenAI-compatible server from LM Studio (no key).",
    apiStyle: "openai-chat",
    baseUrl: "http://localhost:1234/v1",
    models: {
      default: "llama-3.1-8b-instruct",
      popular: ["llama-3.1-8b-instruct", "qwen2.5-7b-instruct"],
    },
    authHeader: "none",
    envVar: "SWARM_KEYS_LMSTUDIO",
    links: {
      console: "https://lmstudio.ai",
      docs: "https://lmstudio.ai/docs",
    },
    isFree: true,
    isLocal: true,
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    shortDescription: "OpenAI models hosted on Azure (base URL comes from your resource).",
    apiStyle: "openai-chat",
    models: {
      default: "gpt-4o",
      popular: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    },
    authHeader: "custom",
    auth: { scheme: "custom-header", headerName: "api-key" },
    authHint: "Paste your resource's OpenAI endpoint and send the key in an api-key header.",
    envVar: "SWARM_KEYS_AZURE_OPENAI",
    standardEnvVar: "AZURE_OPENAI_API_KEY",
    links: {
      signup: "https://azure.microsoft.com/en-us/products/ai-services/openai-service",
      console: "https://oai.azure.com",
      docs: "https://learn.microsoft.com/en-us/azure/ai-services/openai/",
      pricing: "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/",
    },
  },
  {
    id: "aws-bedrock",
    name: "AWS Bedrock",
    shortDescription: "Foundation models via Amazon Bedrock (use an OpenAI-compatible gateway).",
    apiStyle: "openai-chat",
    models: {
      default: "anthropic.claude-sonnet-4-5",
      popular: ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku-4-5", "amazon.nova-pro", "amazon.nova-lite"],
    },
    authHeader: "bearer",
    auth: { scheme: "bearer" },
    authHint: "Bedrock's native API is SigV4-signed; point this at an OpenAI-compatible Bedrock gateway and use its token.",
    envVar: "SWARM_KEYS_AWS_BEDROCK",
    standardEnvVar: "AWS_ACCESS_KEY_ID",
    links: {
      console: "https://console.aws.amazon.com/bedrock",
      docs: "https://docs.aws.amazon.com/bedrock/",
      pricing: "https://aws.amazon.com/bedrock/pricing/",
    },
  },
  {
    id: "friendli",
    name: "FriendliAI",
    shortDescription: "Fast serverless inference for open models on FriendliAI.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.friendli.ai/serverless/v1",
    models: {
      default: "meta-llama-3.3-70b-instruct",
      popular: ["meta-llama-3.3-70b-instruct", "meta-llama-3.1-8b-instruct", "qwen2.5-72b-instruct"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_FRIENDLI",
    standardEnvVar: "FRIENDLI_TOKEN",
    links: {
      console: "https://suite.friendli.ai",
      docs: "https://docs.friendli.ai",
      pricing: "https://friendli.ai/pricing",
    },
  },
  {
    id: "runcrate",
    name: "Runcrate",
    shortDescription: "OpenAI-compatible inference from Runcrate.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.runcrate.ai/v1",
    models: {
      default: "llama-3.3-70b-instruct",
      popular: ["llama-3.3-70b-instruct", "qwen2.5-72b-instruct"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_RUNCRATE",
    standardEnvVar: "RUNCRATE_API_KEY",
    links: {
      signup: "https://runcrate.ai",
      docs: "https://runcrate.ai",
    },
  },
  {
    id: "modal",
    name: "Modal",
    shortDescription: "Call a Modal-hosted model through its OpenAI-compatible proxy.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.modal.com/v1",
    models: {
      popular: [],
    },
    authHeader: "bearer",
    auth: { scheme: "bearer" },
    authHint: "Modal proxy tokens use the ID.SECRET form and are sent as a Bearer token; use the model id your deployment exposes.",
    envVar: "SWARM_KEYS_MODAL",
    standardEnvVar: "MODAL_PROXY_TOKEN",
    links: {
      console: "https://modal.com",
      docs: "https://modal.com/docs",
      pricing: "https://modal.com/pricing",
    },
  },
  {
    id: "zai",
    name: "Z.ai (GLM)",
    shortDescription: "GLM models from Z.ai via the openAI-compatible API.",
    apiStyle: "openai-chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: {
      // GLM thinking is a request parameter ("thinking": {"type": "enabled"}),
      // not a separate model id; there is no glm-4.5-thinking model.
      default: "glm-4.5",
      popular: ["glm-4.5", "glm-4.5-air"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_ZAI",
    standardEnvVar: "ZAI_API_KEY",
    links: {
      signup: "https://z.ai",
      docs: "https://docs.z.ai",
    },
  },
  {
    id: "qwen",
    name: "Alibaba Qwen (DashScope)",
    shortDescription: "Qwen models via Alibaba Cloud Model Studio (DashScope).",
    apiStyle: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: {
      // The coder model is qwen3-coder-plus; bare "qwen3-coder" is not an id.
      default: "qwen3.7-plus",
      popular: ["qwen3.7-plus", "qwen3.8-max", "qwen-plus", "qwen3-coder-plus"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_QWEN",
    standardEnvVar: "DASHSCOPE_API_KEY",
    links: {
      console: "https://dashscope.console.aliyun.com",
      docs: "https://help.aliyun.com/zh/model-studio/getting-started/what-is-model-studio",
    },
  },
  {
    id: "moonshot",
    name: "Moonshot AI (Kimi)",
    shortDescription: "Kimi models via the Moonshot platform API.",
    apiStyle: "openai-chat",
    // Global endpoint; api.moonshot.cn serves the China platform.
    baseUrl: "https://api.moonshot.ai/v1",
    models: {
      // The moonshot-v1-* series is sunset and kimi-k2 is retiring.
      default: "kimi-k3",
      popular: ["kimi-k3", "kimi-k3.1-pro", "kimi-k2.6", "kimi-k2.7-code"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_MOONSHOT",
    standardEnvVar: "MOONSHOT_API_KEY",
    links: {
      console: "https://platform.moonshot.ai",
    },
  },
  {
    id: "minimax",
    name: "MiniMax",
    shortDescription: "MiniMax models via the platform API.",
    apiStyle: "openai-chat",
    // Global endpoint; api.minimax.chat is the legacy host.
    baseUrl: "https://api.minimax.io/v1",
    models: {
      default: "MiniMax-M3",
      popular: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_MINIMAX",
    standardEnvVar: "MINIMAX_API_KEY",
    links: {
      console: "https://platform.minimax.io",
      docs: "https://platform.minimax.io/docs/guides/text-generation",
    },
  },
  // More OpenAI-compatible hosts and local servers (see catalog-more.ts).
  // "custom" must stay last: the providers page opens it as the catch-all.
  ...MORE_PROVIDER_CATALOG,
  {
    id: "custom",
    name: "Custom endpoint",
    shortDescription: "Any endpoint — pick its API style, auth, and model ids.",
    apiStyle: "openai-chat",
    models: {
      popular: [],
    },
    authHeader: "bearer",
    envVar: "SWARM_KEYS_CUSTOM",
    links: {},
    authHint: "OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini or native Ollama.",
  },
];

/**
 * Normalize an arbitrary provider id string into a safe, canonical slug.
 *
 * Trims, lowercases, replaces non-alphanumeric/dash runs with dashes,
 * and strips leading/trailing dashes.
 */
export function canonicalProviderId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Look up a catalog entry by id. */
export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  const canonical = canonicalProviderId(id);
  return PROVIDER_CATALOG.find((entry) => entry.id === (canonical || id));
}

/**
 * Model ids that shipped as catalog defaults and were later corrected.
 * Saved provider configs written while the wrong default was live still
 * carry the old id; the store rewrites them on load (see
 * repairLegacyModelIds in ./store). Keyed by provider id, then old model id.
 */
export const LEGACY_MODEL_ID_REPAIRS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  inception: { mercury: "mercury-3" },
  // Sonar Chat Completions ids (retired 2026-09-27). On the Agent API the
  // old quality tiers are effort levels of the single perplexity/sonar
  // model; the repair lands on the model and the style repair below moves
  // the config onto the Responses wire.
  perplexity: {
    sonar: "perplexity/sonar",
    "sonar-pro": "perplexity/sonar",
    "sonar-reasoning": "perplexity/sonar",
    "sonar-reasoning-pro": "perplexity/sonar",
    "sonar-deep-research": "perplexity/sonar",
  },
};

/** The corrected model id for a legacy saved id, or the id unchanged. */
export function repairedModelId(providerId: string, modelId: string): string {
  return LEGACY_MODEL_ID_REPAIRS[canonicalProviderId(providerId)]?.[modelId] ?? modelId;
}

/**
 * Wire styles that shipped as catalog defaults and were later corrected.
 * Same load-time repair as LEGACY_MODEL_ID_REPAIRS: a saved config still
 * carrying the old style is rewritten to the current one. Keyed by
 * provider id, then old style.
 */
export const LEGACY_API_STYLE_REPAIRS: Readonly<
  Record<
    string,
    Readonly<
      Partial<
        Record<
          CatalogApiStyle,
          Exclude<CatalogApiStyle, "openai-compatible" | "custom">
        >
      >
    >
  >
> = {
  // Perplexity retired Sonar Chat Completions (2026-09-27); the Agent API
  // speaks the OpenAI Responses format.
  perplexity: { "openai-chat": "openai-responses" },
};

/**
 * Hosts a provider's legacy repairs apply to, when a repair is only valid
 * against the provider's own API. A saved config pointing the same
 * provider id at a gateway that still speaks the old wire format keeps
 * its saved style and model ids. Providers not listed are repaired on
 * any host.
 */
export const LEGACY_REPAIR_HOSTS: Readonly<Record<string, readonly string[]>> = {
  perplexity: ["api.perplexity.ai"],
};

/** The corrected wire style for a legacy saved style, or the style unchanged. */
export function repairedApiStyle(
  providerId: string,
  style: CatalogApiStyle,
): CatalogApiStyle {
  return LEGACY_API_STYLE_REPAIRS[canonicalProviderId(providerId)]?.[style] ?? style;
}
