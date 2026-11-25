import { CONNECTORS, type ConnectorEntry } from "../library/catalog";
import type { SecretKind } from "../secrets/allowlist";

export type ConnectorCategory =
  | "code-cloud"
  | "search-data"
  | "apps-productivity"
  | "design-files";

export interface ConnectorFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
  hint?: string;
  helpUrl?: string;
}

export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  vendor: string;
  category: ConnectorCategory;
  description: string;
  unlocks: string;
  badges: readonly string[];
  isFree?: boolean;
  accent: string;
  docsUrl: string;
  keyHelpUrl?: string;
  /** Repo provider id in lib/providers/catalog.ts, if applicable. */
  providerId?: string;
  /** Repo MCP connector id in lib/library/catalog/connectors.json, if applicable. */
  libraryConnectorId?: string;
  /** Secret vault entry id + allowlisted host kind in lib/secrets/allowlist.ts, if applicable. */
  vaultSecret?: {
    id: string;
    kind: SecretKind;
    label: string;
  };
  fields: readonly ConnectorFieldSpec[];
}

export const CONNECTOR_CATEGORIES: ReadonlyArray<{ id: "all" | ConnectorCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "code-cloud", label: "Code & Cloud" },
  { id: "search-data", label: "Search & Data" },
  { id: "apps-productivity", label: "Apps & Productivity" },
  { id: "design-files", label: "Design & Files" },
];

const CORE_CONNECTORS: readonly ConnectorCatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    vendor: "GitHub",
    category: "code-cloud",
    description:
      "Connect GitHub once to power GitHub Models routing, read-only GitHub MCP repo lookups, and the api.github.com secret vault proxy.",
    unlocks: "GitHub Models inference, GitHub Read-Only MCP tools, and vaulted GITHUB_TOKEN / GH_TOKEN calls inside agent VMs.",
    badges: ["Models", "MCP", "Vault Proxy"],
    isFree: true,
    accent: "#38bdf8",
    docsUrl: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
    keyHelpUrl: "https://github.com/settings/tokens",
    providerId: "github",
    libraryConnectorId: "github-read-only",
    vaultSecret: { id: "github", kind: "github", label: "GitHub" },
    fields: [
      {
        key: "token",
        label: "GitHub Personal Access Token",
        placeholder: "ghp_… or github_pat_…",
        secret: true,
        required: true,
        hint: "Grant repo / models:read access depending on which GitHub capabilities you want agents to use.",
        helpUrl: "https://github.com/settings/tokens",
      },
    ],
  },
  {
    id: "vercel",
    name: "Vercel",
    vendor: "Vercel",
    category: "code-cloud",
    description:
      "Connect Vercel AI Gateway for model routing and seal VERCEL_TOKEN into the secret vault proxy for api.vercel.com requests.",
    unlocks: "Vercel AI Gateway provider routing plus vaulted VERCEL_TOKEN injection inside agent VMs.",
    badges: ["Models", "Vault Proxy"],
    accent: "#e4e4e7",
    docsUrl: "https://vercel.com/docs/ai-gateway",
    keyHelpUrl: "https://vercel.com/ai-gateway",
    providerId: "vercel",
    vaultSecret: { id: "vercel", kind: "vercel", label: "Vercel" },
    fields: [
      {
        key: "token",
        label: "Vercel Token / AI Gateway Key",
        placeholder: "vck_… or Vercel access token",
        secret: true,
        required: true,
        hint: "Sealed per-account and proxied via api.vercel.com so raw tokens stay outside the VM.",
        helpUrl: "https://vercel.com/ai-gateway",
      },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    vendor: "Cloudflare",
    category: "code-cloud",
    description:
      "Connect Cloudflare Workers AI models with your API token and optional Account ID for OpenAI-compatible inference.",
    unlocks: "Cloudflare Workers AI provider routing with free daily neuron allowance.",
    badges: ["Models", "Free Tier"],
    isFree: true,
    accent: "#f97316",
    docsUrl: "https://developers.cloudflare.com/workers-ai/",
    keyHelpUrl: "https://dash.cloudflare.com/profile/api-tokens",
    providerId: "cloudflare",
    fields: [
      {
        key: "token",
        label: "Cloudflare API Token",
        placeholder: "Cloudflare Workers AI API token",
        secret: true,
        required: true,
        helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
      },
      {
        key: "accountId",
        label: "Cloudflare Account ID (optional)",
        placeholder: "32-character account ID",
        secret: false,
        required: false,
        hint: "When supplied, sets your Workers AI base URL to api.cloudflare.com/client/v4/accounts/<id>/ai/v1.",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI + Docs MCP",
    vendor: "OpenAI",
    category: "code-cloud",
    description:
      "Connect your OpenAI API key for GPT/o-series models and automatically mount the official OpenAI Developer Docs MCP server.",
    unlocks: "OpenAI model routing plus live OpenAI API & Codex documentation tools in agent runs.",
    badges: ["Models", "MCP"],
    accent: "#10b981",
    docsUrl: "https://developers.openai.com/learn/docs-mcp",
    keyHelpUrl: "https://platform.openai.com/api-keys",
    providerId: "openai",
    libraryConnectorId: "openai-docs",
    fields: [
      {
        key: "token",
        label: "OpenAI API Key",
        placeholder: "sk-…",
        secret: true,
        required: true,
        helpUrl: "https://platform.openai.com/api-keys",
      },
    ],
  },
  {
    id: "brave-search",
    name: "Brave Search",
    vendor: "Brave",
    category: "search-data",
    description:
      "Give agents real-time web, news, and image search via the Brave Search MCP server automatically mounted in VM runs.",
    unlocks: "brave_web_search, brave_news_search, brave_image_search, and brave_local_search MCP tools.",
    badges: ["MCP", "Web Search"],
    accent: "#fb7185",
    docsUrl: "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.brave%2Fbrave-search-mcp-server/versions/latest",
    keyHelpUrl: "https://api.search.brave.com/app/keys",
    libraryConnectorId: "brave-search",
    fields: [
      {
        key: "BRAVE_API_KEY",
        label: "Brave Search API Key",
        placeholder: "BSA…",
        secret: true,
        required: true,
        helpUrl: "https://api.search.brave.com/app/keys",
      },
    ],
  },
  {
    id: "exa",
    name: "Exa Web Search",
    vendor: "Exa",
    category: "search-data",
    description:
      "One-click zero-key connection to Exa's hosted MCP server for neural web search and clean page extraction inside agent VMs.",
    unlocks: "web_search_exa and web_fetch_exa tools seeded into every agent VM run.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#818cf8",
    docsUrl: "https://registry.modelcontextprotocol.io/v0.1/servers/ai.exa%2Fexa/versions/latest",
    libraryConnectorId: "exa",
    fields: [],
  },
  {
    id: "sqlite-read-only",
    name: "SQLite (Read-only)",
    vendor: "MCP Community",
    category: "search-data",
    description:
      "One-click zero-key connection to inspect and query SQLite files in /workspace using a read-only stdio MCP server.",
    unlocks: "list_tables, describe_table, and read-only SQLite query tools inside agent VMs.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#2dd4bf",
    docsUrl: "https://github.com/djgadd/sqlite-mcp",
    libraryConnectorId: "sqlite-read-only",
    fields: [],
  },
  {
    id: "playwright-browser",
    name: "Playwright Browser",
    vendor: "Microsoft MCP",
    category: "code-cloud",
    description:
      "One-click zero-key browser automation MCP server for navigating live pages, filling forms, and capturing screenshots inside agent VMs.",
    unlocks: "browser_navigate, browser_click, browser_type, and screenshot tools inside agent VMs.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#34d399",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    libraryConnectorId: "playwright",
    fields: [],
  },
  {
    id: "fetch-web",
    name: "Web Fetch",
    vendor: "MCP Reference",
    category: "search-data",
    description:
      "One-click zero-key HTTP/Markdown fetch MCP server for reading documentation, APIs, and web pages cleanly.",
    unlocks: "fetch tool for converting web pages to clean markdown inside agent VMs.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#60a5fa",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    libraryConnectorId: "fetch",
    fields: [],
  },
  {
    id: "git-workspace",
    name: "Git Workspace",
    vendor: "MCP Reference",
    category: "code-cloud",
    description:
      "One-click zero-key Git MCP server for inspecting diffs, commit history, branches, and status in /workspace.",
    unlocks: "git_status, git_diff, git_log, and branch tools inside agent VMs.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#f472b6",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    libraryConnectorId: "git",
    fields: [],
  },
];

const LIBRARY_CATEGORY_MAP: Record<string, ConnectorCategory> = {
  dev: "code-cloud",
  cloud: "code-cloud",
  browser: "code-cloud",
  search: "search-data",
  data: "search-data",
  communication: "apps-productivity",
  productivity: "apps-productivity",
  finance: "apps-productivity",
  design: "design-files",
  files: "design-files",
};

const CATEGORY_ACCENTS: Record<ConnectorCategory, string> = {
  "code-cloud": "#38bdf8",
  "search-data": "#818cf8",
  "apps-productivity": "#f59e0b",
  "design-files": "#ec4899",
};

function projectLibraryConnector(entry: ConnectorEntry): ConnectorCatalogEntry {
  const category = LIBRARY_CATEGORY_MAP[entry.category] ?? "code-cloud";
  const isZeroKey = entry.requiredFields.length === 0 && (entry.auth === "none" || !entry.auth);
  const badges: string[] = ["MCP"];
  if (isZeroKey) {
    badges.push("1-Click", "Zero Key");
  } else if (entry.auth === "oauth") {
    badges.push("OAuth / Token");
  }
  if (entry.tools.length > 0) {
    badges.push(`${entry.tools.length} Tools`);
  }
  const unlocks =
    entry.tools.length > 0
      ? `${entry.tools.slice(0, 6).join(", ")}${entry.tools.length > 6 ? `, +${entry.tools.length - 6} more` : ""} MCP tools inside agent VMs.`
      : `${entry.name} (${entry.transport.toUpperCase()}) MCP tools seeded into agent VM runs.`;

  return {
    id: entry.id,
    name: entry.name,
    vendor: entry.category.charAt(0).toUpperCase() + entry.category.slice(1),
    category,
    description: entry.description || `${entry.name} MCP integration.`,
    unlocks,
    badges,
    ...(isZeroKey ? { isFree: true } : {}),
    accent: CATEGORY_ACCENTS[category],
    docsUrl: entry.sourceUrl ?? "https://modelcontextprotocol.io/docs",
    ...(entry.requiredFields[0]?.helpUrl ? { keyHelpUrl: entry.requiredFields[0].helpUrl } : {}),
    libraryConnectorId: entry.id,
    fields: entry.requiredFields.map((field) => ({
      key: field.key,
      label: field.label,
      secret: field.secret,
      required: true,
      ...(field.helpUrl ? { helpUrl: field.helpUrl } : {}),
    })),
  };
}

const coveredIds = new Set<string>();
for (const core of CORE_CONNECTORS) {
  coveredIds.add(core.id);
  if (core.libraryConnectorId) coveredIds.add(core.libraryConnectorId);
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  ...CORE_CONNECTORS,
  ...CONNECTORS.filter((entry) => !coveredIds.has(entry.id)).map(projectLibraryConnector),
];

export function findCatalogConnector(id: string): ConnectorCatalogEntry | null {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id) ?? null;
}
