import type { ProviderKind } from "./types";

// The connection catalog: every LLM provider, tool API key and MCP server the user can add from Settings.
// This file is pure data and is shipped to the browser, so it must never contain secrets.
// Placeholders: "{key}" in headers/URLs is replaced with the stored key at request time on the server;
// "{name}" in a baseUrl is filled from the matching entry in `vars`.

export type ConnType = "llm" | "tool" | "mcp";

export interface TemplateVar {
  key: string;
  label: string;
  placeholder: string;
  default?: string;
}

export interface Preset {
  /** Catalog id. Stored on the connection as `preset`. */
  id: string;
  /** Wire protocol: "anthropic" uses the native Messages API; every other kind speaks OpenAI chat completions. */
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  /** Default model; empty means "first model the provider lists". */
  model: string;
  keyUrl?: string;
  needsKey: boolean;
  /** One-click account connection (OAuth) instead of pasting a key. */
  oauth?: boolean;
  group: "Connect" | "Major labs" | "Fast inference" | "Aggregators & hosts" | "Clouds" | "Local" | "Custom";
  /** Extra request headers; values may contain {key}. */
  headers?: Record<string, string>;
  /** Pieces of the base URL the user must fill in (Azure resource, AWS region…). */
  vars?: TemplateVar[];
  /** The base URL is user-editable (local servers, custom endpoints). */
  editableUrl?: boolean;
  /** The provider has no /models endpoint; Test sends a 1-token request to the chosen model instead. */
  noModelList?: boolean;
  blurb?: string;
}

const P = (p: Omit<Preset, "id"> & { id?: string }): Preset => ({ ...p, id: p.id ?? p.kind });

// Every provider here except the "anthropic" kinds speaks the OpenAI-compatible chat API, so adding one is a single line.
// Settings fetches each provider's live model list, so defaults only matter until then.
export const PRESETS: Preset[] = [
  P({ group: "Connect", kind: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-opus-5.5", keyUrl: "https://openrouter.ai/keys", needsKey: true, oauth: true, blurb: "Hundreds of models behind one account. Sign in to connect." }),

  P({ group: "Major labs", kind: "anthropic", label: "Anthropic", model: "claude-opus-5-5", keyUrl: "https://console.anthropic.com/settings/keys", needsKey: true, blurb: "Claude, via the native API with thinking and prompt caching." }),
  P({ group: "Major labs", kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5", keyUrl: "https://platform.openai.com/api-keys", needsKey: true }),
  P({ group: "Major labs", kind: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro", keyUrl: "https://aistudio.google.com/apikey", needsKey: true }),
  P({ group: "Major labs", kind: "xai", label: "xAI Grok", baseUrl: "https://api.x.ai/v1", model: "grok-4", keyUrl: "https://console.x.ai", needsKey: true }),
  P({ group: "Major labs", kind: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest", keyUrl: "https://console.mistral.ai/api-keys", needsKey: true }),
  P({ group: "Major labs", kind: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", needsKey: true }),
  P({ group: "Major labs", kind: "moonshot", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.ai/v1", model: "", keyUrl: "https://platform.moonshot.ai/console/api-keys", needsKey: true }),
  P({ group: "Major labs", kind: "qwen", label: "Alibaba Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-max", keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key", needsKey: true }),
  P({ group: "Major labs", kind: "zhipu", label: "Zhipu GLM", baseUrl: "https://api.z.ai/api/paas/v4", model: "", keyUrl: "https://z.ai/manage-apikey/apikey-list", needsKey: true }),
  P({ group: "Major labs", kind: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", model: "", keyUrl: "https://www.minimax.io/platform/user-center/basic-information/interface-key", needsKey: true }),
  P({ group: "Major labs", kind: "cohere", label: "Cohere", baseUrl: "https://api.cohere.ai/compatibility/v1", model: "command-a-03-2025", keyUrl: "https://dashboard.cohere.com/api-keys", needsKey: true }),
  P({ group: "Major labs", kind: "perplexity", label: "Perplexity", baseUrl: "https://api.perplexity.ai", model: "sonar-pro", keyUrl: "https://www.perplexity.ai/account/api/keys", needsKey: true, noModelList: true }),

  P({ group: "Fast inference", kind: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", keyUrl: "https://console.groq.com/keys", needsKey: true }),
  P({ group: "Fast inference", kind: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "", keyUrl: "https://cloud.cerebras.ai/platform", needsKey: true }),
  P({ group: "Fast inference", kind: "sambanova", label: "SambaNova", baseUrl: "https://api.sambanova.ai/v1", model: "", keyUrl: "https://cloud.sambanova.ai/apis", needsKey: true }),

  P({ group: "Aggregators & hosts", kind: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", model: "", keyUrl: "https://api.together.ai/settings/api-keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", model: "", keyUrl: "https://fireworks.ai/settings/users/api-keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "deepinfra", label: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", model: "", keyUrl: "https://deepinfra.com/dash/api_keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", model: "", keyUrl: "https://huggingface.co/settings/tokens", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "github", label: "GitHub Models", baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4.1", keyUrl: "https://github.com/settings/personal-access-tokens", needsKey: true, noModelList: true }),
  P({ group: "Aggregators & hosts", kind: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", model: "", keyUrl: "https://build.nvidia.com/settings/api-keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "vercel", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", model: "", keyUrl: "https://vercel.com/dashboard/ai-gateway/api-keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "requesty", label: "Requesty", baseUrl: "https://router.requesty.ai/v1", model: "", keyUrl: "https://app.requesty.ai/api-keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "nebius", label: "Nebius", baseUrl: "https://api.studio.nebius.com/v1", model: "", keyUrl: "https://studio.nebius.com/settings/api-keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "novita", label: "Novita", baseUrl: "https://api.novita.ai/v3/openai", model: "", keyUrl: "https://novita.ai/settings/key-management", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "hyperbolic", label: "Hyperbolic", baseUrl: "https://api.hyperbolic.xyz/v1", model: "", keyUrl: "https://app.hyperbolic.xyz/settings", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "baseten", label: "Baseten", baseUrl: "https://inference.baseten.co/v1", model: "", keyUrl: "https://app.baseten.co/settings/api_keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "featherless", label: "Featherless", baseUrl: "https://api.featherless.ai/v1", model: "", keyUrl: "https://featherless.ai/account/api-keys", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "chutes", label: "Chutes", baseUrl: "https://llm.chutes.ai/v1", model: "", keyUrl: "https://chutes.ai/app/api", needsKey: true }),
  P({ group: "Aggregators & hosts", kind: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", model: "", keyUrl: "https://venice.ai/settings/api", needsKey: true }),

  P({
    group: "Clouds", kind: "azure", label: "Azure OpenAI", baseUrl: "https://{resource}.openai.azure.com/openai/v1", model: "", needsKey: true,
    keyUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
    headers: { "api-key": "{key}" }, vars: [{ key: "resource", label: "Resource name", placeholder: "my-openai" }],
    blurb: "Use your deployment name as the model.",
  }),
  P({
    group: "Clouds", kind: "bedrock", label: "AWS Bedrock", baseUrl: "https://bedrock-runtime.{region}.amazonaws.com/openai/v1", model: "openai.gpt-oss-120b-1:0", needsKey: true, noModelList: true,
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys", vars: [{ key: "region", label: "Region", placeholder: "us-east-1", default: "us-east-1" }],
    blurb: "Bedrock API key, OpenAI-compatible endpoint.",
  }),
  P({
    id: "bedrock-claude", group: "Clouds", kind: "anthropic", label: "Claude on Bedrock", baseUrl: "https://bedrock-runtime.{region}.amazonaws.com/anthropic", model: "us.anthropic.claude-sonnet-4-6", needsKey: true, noModelList: true,
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys", headers: { Authorization: "Bearer {key}" }, vars: [{ key: "region", label: "Region", placeholder: "us-east-1", default: "us-east-1" }],
    blurb: "Bedrock API key, native Anthropic Messages API.",
  }),
  P({
    group: "Clouds", kind: "cloudflare", label: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1", model: "@cf/openai/gpt-oss-120b", needsKey: true, noModelList: true,
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens", vars: [{ key: "account", label: "Account ID", placeholder: "0123abcd…" }],
  }),

  P({ group: "Local", kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "", needsKey: false, editableUrl: true }),
  P({ group: "Local", kind: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", model: "", needsKey: false, editableUrl: true }),
  P({ group: "Local", kind: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", model: "", needsKey: false, editableUrl: true }),
  P({ group: "Local", kind: "llamacpp", label: "llama.cpp server", baseUrl: "http://127.0.0.1:8080/v1", model: "", needsKey: false, editableUrl: true }),
  P({ group: "Local", kind: "jan", label: "Jan", baseUrl: "http://127.0.0.1:1337/v1", model: "", needsKey: false, editableUrl: true }),
  P({ group: "Local", kind: "litellm", label: "LiteLLM proxy", baseUrl: "http://127.0.0.1:4000/v1", model: "", needsKey: false, editableUrl: true }),

  P({ group: "Custom", kind: "custom", label: "OpenAI-compatible endpoint", baseUrl: "", model: "", needsKey: false, editableUrl: true, blurb: "Any server that speaks /v1/chat/completions." }),
  P({ id: "custom-anthropic", group: "Custom", kind: "anthropic", label: "Anthropic-compatible endpoint", baseUrl: "", model: "", needsKey: false, editableUrl: true, blurb: "Any server that speaks the Anthropic Messages API (z.ai, MiniMax, Kimi, DeepSeek, proxies)." }),
];

/** Look up an LLM preset by catalog id, falling back to kind, then to the generic custom endpoint. */
export const presetFor = (idOrKind: string) =>
  PRESETS.find((p) => p.id === idOrKind) ?? PRESETS.find((p) => p.kind === idOrKind) ?? PRESETS.find((p) => p.id === "custom")!;

// ---- Tool API keys ----
// Keys for services the agent's tools use. The agent calls these APIs through the `api_request` tool, which
// adds the key server-side and only sends it to the service's own hosts (`api`, else derived from `test`).
// `test` is a cheap read-only request that proves the key works.

export interface KeyTest {
  method?: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Success also requires this top-level JSON field to be truthy (APIs that answer 200 with ok:false). */
  okField?: string;
}

export interface ToolPreset {
  id: string;
  label: string;
  group: "Search" | "Web & scraping" | "Images & video" | "Voice" | "Dev & data" | "Custom";
  envVar: string;
  keyUrl?: string;
  blurb: string;
  test?: KeyTest;
  /** Used by built-in tools (e.g. web_search) in addition to api_request. */
  builtin?: "search";
  /** Where api_request may send this key and how. Defaults: the test URL's host, and the test's {key} headers/query. */
  api?: { hosts?: string[]; auth?: Record<string, string>; docs?: string };
}

/** How api_request authenticates to a service: allowed hosts, auth headers ({key} templates), auth query params. */
export function apiAccess(p: ToolPreset): { hosts: string[]; headers: Record<string, string>; query: Record<string, string>; docs?: string } | null {
  const test = p.test ? new URL(p.test.url) : null;
  const hosts = p.api?.hosts ?? (test ? [test.host] : []);
  const headers = p.api?.auth ?? p.test?.headers ?? {};
  const query: Record<string, string> = {};
  if (!p.api?.auth && test) for (const [k, v] of test.searchParams) if (v.includes("{key}")) query[k] = v;
  if (!hosts.length || (!Object.values(headers).some((v) => v.includes("{key}")) && !Object.keys(query).length)) return null;
  return { hosts, headers, query, docs: p.api?.docs };
}

const bearer = { Authorization: "Bearer {key}" };

export const TOOL_PRESETS: ToolPreset[] = [
  { id: "brave", label: "Brave Search", group: "Search", envVar: "BRAVE_API_KEY", builtin: "search", keyUrl: "https://api-dashboard.search.brave.com/app/keys", blurb: "Independent web index. Powers web_search.", test: { url: "https://api.search.brave.com/res/v1/web/search?q=swarm&count=1", headers: { "X-Subscription-Token": "{key}", Accept: "application/json" } } },
  { id: "tavily", label: "Tavily", group: "Search", envVar: "TAVILY_API_KEY", builtin: "search", keyUrl: "https://app.tavily.com/home", blurb: "Search built for agents. Powers web_search.", test: { method: "POST", url: "https://api.tavily.com/search", headers: bearer, body: { query: "swarm", max_results: 1 } } },
  { id: "exa", label: "Exa", group: "Search", envVar: "EXA_API_KEY", builtin: "search", keyUrl: "https://dashboard.exa.ai/api-keys", blurb: "Neural search. Powers web_search.", test: { method: "POST", url: "https://api.exa.ai/search", headers: { "x-api-key": "{key}" }, body: { query: "swarm", numResults: 1 } } },
  { id: "serper", label: "Serper (Google)", group: "Search", envVar: "SERPER_API_KEY", builtin: "search", keyUrl: "https://serper.dev/api-key", blurb: "Google results. Powers web_search.", test: { method: "POST", url: "https://google.serper.dev/search", headers: { "X-API-KEY": "{key}" }, body: { q: "swarm", num: 1 } } },
  { id: "serpapi", label: "SerpApi", group: "Search", envVar: "SERPAPI_API_KEY", keyUrl: "https://serpapi.com/manage-api-key", blurb: "Google, Bing, Scholar and more.", test: { url: "https://serpapi.com/account.json?api_key={key}" } },
  { id: "kagi", label: "Kagi", group: "Search", envVar: "KAGI_API_KEY", keyUrl: "https://kagi.com/settings?p=api", blurb: "Ad-free search API.", test: { url: "https://kagi.com/api/v0/search?q=swarm&limit=1", headers: { Authorization: "Bot {key}" } } },

  { id: "firecrawl", label: "Firecrawl", group: "Web & scraping", envVar: "FIRECRAWL_API_KEY", keyUrl: "https://www.firecrawl.dev/app/api-keys", blurb: "Crawl and scrape sites to clean markdown.", test: { url: "https://api.firecrawl.dev/v1/team/credit-usage", headers: bearer } },
  { id: "jina", api: { hosts: ["r.jina.ai", "s.jina.ai", "api.jina.ai"], auth: { Authorization: "Bearer {key}" } }, label: "Jina Reader", group: "Web & scraping", envVar: "JINA_API_KEY", keyUrl: "https://jina.ai/api-dashboard", blurb: "URL to LLM-ready text, higher rate limits.", test: { url: "https://r.jina.ai/https://example.com", headers: { ...bearer, Accept: "text/plain" } } },
  { id: "browserbase", label: "Browserbase", group: "Web & scraping", envVar: "BROWSERBASE_API_KEY", keyUrl: "https://www.browserbase.com/settings", blurb: "Hosted headless browsers.", test: { url: "https://api.browserbase.com/v1/projects", headers: { "X-BB-API-Key": "{key}" } } },

  { id: "replicate", api: { hosts: ["api.replicate.com"], auth: { Authorization: "Bearer {key}" }, docs: "POST /v1/models/<owner>/<name>/predictions with {input:{…}} and header Prefer: wait" }, label: "Replicate", group: "Images & video", envVar: "REPLICATE_API_TOKEN", keyUrl: "https://replicate.com/account/api-tokens", blurb: "Run image, video and audio models.", test: { url: "https://api.replicate.com/v1/account", headers: bearer } },
  { id: "fal", api: { hosts: ["fal.run", "queue.fal.run", "rest.alpha.fal.ai"], auth: { Authorization: "Key {key}" }, docs: "POST https://fal.run/<model-id> with the model's JSON input" }, label: "fal.ai", group: "Images & video", envVar: "FAL_KEY", keyUrl: "https://fal.ai/dashboard/keys", blurb: "Fast image and video generation." },
  { id: "stability", label: "Stability AI", group: "Images & video", envVar: "STABILITY_API_KEY", keyUrl: "https://platform.stability.ai/account/keys", blurb: "Stable Diffusion image models.", test: { url: "https://api.stability.ai/v1/user/account", headers: bearer } },

  { id: "elevenlabs", api: { hosts: ["api.elevenlabs.io"], auth: { "xi-api-key": "{key}" }, docs: "POST /v1/text-to-speech/<voice_id> {text} returns audio/mpeg (saved to downloads)" }, label: "ElevenLabs", group: "Voice", envVar: "ELEVENLABS_API_KEY", keyUrl: "https://elevenlabs.io/app/settings/api-keys", blurb: "Text to speech and voice cloning.", test: { url: "https://api.elevenlabs.io/v1/models", headers: { "xi-api-key": "{key}" } } },
  { id: "deepgram", label: "Deepgram", group: "Voice", envVar: "DEEPGRAM_API_KEY", keyUrl: "https://console.deepgram.com", blurb: "Speech to text.", test: { url: "https://api.deepgram.com/v1/projects", headers: { Authorization: "Token {key}" } } },
  { id: "assemblyai", label: "AssemblyAI", group: "Voice", envVar: "ASSEMBLYAI_API_KEY", keyUrl: "https://www.assemblyai.com/app/api-keys", blurb: "Speech to text and audio intelligence.", test: { url: "https://api.assemblyai.com/v2/transcript?limit=1", headers: { Authorization: "{key}" } } },

  { id: "github-token", api: { hosts: ["api.github.com", "uploads.github.com"], auth: { Authorization: "Bearer {key}", "User-Agent": "swarmagents", "X-GitHub-Api-Version": "2022-11-28" } }, label: "GitHub token", group: "Dev & data", envVar: "GITHUB_TOKEN", keyUrl: "https://github.com/settings/personal-access-tokens", blurb: "gh, git push and the GitHub API.", test: { url: "https://api.github.com/user", headers: { ...bearer, "User-Agent": "swarmagents" } } },
  { id: "vercel-token", label: "Vercel token", group: "Dev & data", envVar: "VERCEL_TOKEN", keyUrl: "https://vercel.com/account/settings/tokens", blurb: "Deploy and manage Vercel projects.", test: { url: "https://api.vercel.com/v2/user", headers: bearer } },
  { id: "cloudflare-token", label: "Cloudflare token", group: "Dev & data", envVar: "CLOUDFLARE_API_TOKEN", keyUrl: "https://dash.cloudflare.com/profile/api-tokens", blurb: "Wrangler, DNS, Workers.", test: { url: "https://api.cloudflare.com/client/v4/user/tokens/verify", headers: bearer, okField: "success" } },
  { id: "linear-key", label: "Linear", group: "Dev & data", envVar: "LINEAR_API_KEY", keyUrl: "https://linear.app/settings/account/security", blurb: "Issues and projects.", test: { method: "POST", url: "https://api.linear.app/graphql", headers: { Authorization: "{key}" }, body: { query: "{ viewer { id } }" }, okField: "data" } },
  { id: "notion-key", api: { hosts: ["api.notion.com"], auth: { Authorization: "Bearer {key}", "Notion-Version": "2022-06-28" } }, label: "Notion", group: "Dev & data", envVar: "NOTION_API_KEY", keyUrl: "https://www.notion.so/profile/integrations", blurb: "Pages and databases.", test: { url: "https://api.notion.com/v1/users/me", headers: { ...bearer, "Notion-Version": "2022-06-28" } } },
  { id: "slack-bot", label: "Slack bot token", group: "Dev & data", envVar: "SLACK_BOT_TOKEN", keyUrl: "https://api.slack.com/apps", blurb: "Read and post in Slack.", test: { method: "POST", url: "https://slack.com/api/auth.test", headers: bearer, okField: "ok" } },
  { id: "hf-token", api: { hosts: ["huggingface.co", "router.huggingface.co", "api-inference.huggingface.co", "datasets-server.huggingface.co"], auth: { Authorization: "Bearer {key}" } }, label: "Hugging Face token", group: "Dev & data", envVar: "HF_TOKEN", keyUrl: "https://huggingface.co/settings/tokens", blurb: "Datasets, models, Spaces.", test: { url: "https://huggingface.co/api/whoami-v2", headers: bearer } },

  { id: "custom-key", label: "Other API key", group: "Custom", envVar: "", blurb: "Any key, exposed to the agent's shell under the variable name you choose." },
];

// ---- MCP servers ----

export type McpTransport = "stdio" | "http" | "sse";

export interface McpPreset {
  id: string;
  label: string;
  group: "Remote" | "Local" | "Custom";
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** "oauth": sign in from Settings. "key": paste a token (sent as `keyHeader` or set as env `keyEnv`). */
  auth: "none" | "key" | "oauth" | "optional-key";
  keyHeader?: string;
  keyEnv?: string;
  keyUrl?: string;
  /** Label for a trailing argument the user must supply (a folder, a database URL…). */
  argPrompt?: string;
  blurb: string;
}

export const MCP_PRESETS: McpPreset[] = [
  { id: "github", label: "GitHub", group: "Remote", transport: "http", url: "https://api.githubcopilot.com/mcp/", auth: "key", keyHeader: "Authorization: Bearer {key}", keyUrl: "https://github.com/settings/personal-access-tokens", blurb: "Repos, issues, PRs, Actions." },
  { id: "linear", label: "Linear", group: "Remote", transport: "http", url: "https://mcp.linear.app/mcp", auth: "oauth", blurb: "Issues, projects, cycles." },
  { id: "notion", label: "Notion", group: "Remote", transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth", blurb: "Search and edit your workspace." },
  { id: "sentry", label: "Sentry", group: "Remote", transport: "http", url: "https://mcp.sentry.dev/mcp", auth: "oauth", blurb: "Errors, traces, releases." },
  { id: "atlassian", label: "Atlassian", group: "Remote", transport: "sse", url: "https://mcp.atlassian.com/v1/sse", auth: "oauth", blurb: "Jira and Confluence." },
  { id: "vercel", label: "Vercel", group: "Remote", transport: "http", url: "https://mcp.vercel.com", auth: "oauth", blurb: "Projects, deployments, logs." },
  { id: "supabase", label: "Supabase", group: "Remote", transport: "http", url: "https://mcp.supabase.com/mcp", auth: "oauth", blurb: "Databases, auth, storage." },
  { id: "stripe", label: "Stripe", group: "Remote", transport: "http", url: "https://mcp.stripe.com", auth: "key", keyHeader: "Authorization: Bearer {key}", keyUrl: "https://dashboard.stripe.com/apikeys", blurb: "Payments data. Use a restricted key." },
  { id: "huggingface", label: "Hugging Face", group: "Remote", transport: "http", url: "https://huggingface.co/mcp", auth: "optional-key", keyHeader: "Authorization: Bearer {key}", keyUrl: "https://huggingface.co/settings/tokens", blurb: "Models, datasets, Spaces." },
  { id: "context7", label: "Context7", group: "Remote", transport: "http", url: "https://mcp.context7.com/mcp", auth: "optional-key", keyHeader: "CONTEXT7_API_KEY: {key}", keyUrl: "https://context7.com/dashboard", blurb: "Up-to-date library docs." },
  { id: "deepwiki", label: "DeepWiki", group: "Remote", transport: "http", url: "https://mcp.deepwiki.com/mcp", auth: "none", blurb: "Ask questions about any public GitHub repo." },
  { id: "cloudflare-docs", label: "Cloudflare Docs", group: "Remote", transport: "http", url: "https://docs.mcp.cloudflare.com/mcp", auth: "none", blurb: "Search Cloudflare documentation." },
  { id: "exa", label: "Exa", group: "Remote", transport: "http", url: "https://mcp.exa.ai/mcp", auth: "optional-key", keyHeader: "x-api-key: {key}", keyUrl: "https://dashboard.exa.ai/api-keys", blurb: "Web and code search." },

  { id: "playwright", label: "Playwright", group: "Local", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], auth: "none", blurb: "A second, scriptable browser." },
  { id: "filesystem", label: "Filesystem", group: "Local", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], argPrompt: "Folder to expose", auth: "none", blurb: "Sandboxed file access to one folder." },
  { id: "memory", label: "Memory", group: "Local", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], auth: "none", blurb: "A persistent knowledge graph." },
  { id: "sequential-thinking", label: "Sequential thinking", group: "Local", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"], auth: "none", blurb: "Structured step-by-step reasoning." },
  { id: "fetch", label: "Fetch", group: "Local", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"], auth: "none", blurb: "Fetch pages as markdown (needs uv)." },
  { id: "git", label: "Git", group: "Local", transport: "stdio", command: "uvx", args: ["mcp-server-git"], auth: "none", blurb: "Git operations (needs uv)." },
  { id: "time", label: "Time", group: "Local", transport: "stdio", command: "uvx", args: ["mcp-server-time"], auth: "none", blurb: "Time zones and conversions (needs uv)." },
  { id: "brave-search", label: "Brave Search", group: "Local", transport: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], auth: "key", keyEnv: "BRAVE_API_KEY", keyUrl: "https://api-dashboard.search.brave.com/app/keys", blurb: "Web, news, image search." },
  { id: "postgres", label: "Postgres", group: "Local", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], argPrompt: "Connection URL (postgresql://…)", auth: "none", blurb: "Read-only SQL against a database." },
  { id: "sqlite", label: "SQLite", group: "Local", transport: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db-path"], argPrompt: "Database file", auth: "none", blurb: "Query a SQLite file (needs uv)." },

  { id: "custom-stdio", label: "Local command", group: "Custom", transport: "stdio", command: "", args: [], auth: "none", blurb: "Any MCP server started by a command." },
  { id: "custom-http", label: "Remote URL", group: "Custom", transport: "http", url: "", auth: "none", blurb: "Any Streamable HTTP or SSE MCP server, with OAuth if it supports it." },
];

export const toolPreset = (id: string) => TOOL_PRESETS.find((t) => t.id === id) ?? TOOL_PRESETS.find((t) => t.id === "custom-key")!;
export const mcpPreset = (id: string) => MCP_PRESETS.find((m) => m.id === id);

/** Fill {var} placeholders in a template base URL. Unknown vars are left in place so validation can flag them. */
export function fillTemplate(url: string, vars: Record<string, string>) {
  return url.replace(/\{(\w+)\}/g, (m, k) => (vars[k]?.trim() ? vars[k].trim() : m));
}
