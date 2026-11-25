import type { SecretKind } from "../secrets/allowlist";

export type ConnectorCategory = "code-cloud" | "search-data" | "productivity" | "devops";

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
  { id: "productivity", label: "Productivity" },
  { id: "devops", label: "DevOps & Infra" },
];

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
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
    id: "gitlab",
    name: "GitLab",
    vendor: "GitLab",
    category: "code-cloud",
    description:
      "Connect GitLab to let agents work with projects, issues, and merge requests through the official GitLab MCP server. Sign in with OAuth the first time your agent uses it.",
    unlocks: "GitLab project, issue, and merge-request tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#fc6d26",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/com.gitlab%2Fmcp/versions/latest",
    libraryConnectorId: "gitlab",
    fields: [],
  },
  {
    id: "figma",
    name: "Figma",
    vendor: "Figma",
    category: "code-cloud",
    description:
      "Connect Figma to give agents design context from your files and components. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Figma design context and component tools for development runs.",
    badges: ["MCP", "OAuth"],
    accent: "#a259ff",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/com.figma.mcp%2Fmcp/versions/latest",
    libraryConnectorId: "figma",
    fields: [],
  },
  {
    id: "aws",
    name: "AWS",
    vendor: "Amazon Web Services",
    category: "code-cloud",
    description:
      "Connect the AWS MCP server for AWS documentation search and scripted AWS API tasks inside agent runs. Sign in with OAuth the first time your agent uses it.",
    unlocks:
      "aws___search_documentation, aws___read_documentation, and aws___run_script tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#ff9900",
    docsUrl: "https://docs.aws.amazon.com/agent-toolkit/latest/userguide/what-is-agent-toolkit.html",
    libraryConnectorId: "aws",
    fields: [],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    vendor: "PostgreSQL",
    category: "search-data",
    description:
      "Connect a PostgreSQL database (read-only) so agents can query it with the reference Postgres MCP server.",
    unlocks: "Read-only PostgreSQL query tool for agent runs.",
    badges: ["MCP", "Database"],
    accent: "#336791",
    docsUrl: "https://github.com/modelcontextprotocol/servers/issues/4785",
    libraryConnectorId: "postgres",
    fields: [
      {
        key: "POSTGRES_URL",
        label: "PostgreSQL connection URL",
        placeholder: "postgresql://user:password@host:5432/dbname",
        secret: true,
        required: true,
        hint: "Read-only credentials are recommended; the server only runs queries.",
        helpUrl: "https://www.postgresql.org/docs/current/libpq-connect.html",
      },
    ],
  },
  {
    id: "mongodb",
    name: "MongoDB",
    vendor: "MongoDB",
    category: "search-data",
    description:
      "Connect MongoDB so agents can query and inspect collections through the official MongoDB MCP server.",
    unlocks: "MongoDB collection query and inspection tools in agent runs.",
    badges: ["MCP", "Database"],
    accent: "#47a248",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mongodb-js%2Fmongodb-mcp-server/versions/latest",
    libraryConnectorId: "mongodb",
    fields: [
      {
        key: "MDB_MCP_CONNECTION_STRING",
        label: "MongoDB connection string",
        placeholder: "mongodb+srv://user:password@cluster/db",
        secret: true,
        required: true,
        helpUrl: "https://www.mongodb.com/docs/manual/reference/connection-string/",
      },
    ],
  },
  {
    id: "airtable",
    name: "Airtable",
    vendor: "Airtable",
    category: "search-data",
    description:
      "Connect Airtable to let agents access and update records and bases. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Airtable record and base read/write tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#facc15",
    docsUrl: "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server",
    libraryConnectorId: "airtable",
    fields: [],
  },
  {
    id: "fetch",
    name: "Fetch",
    vendor: "MCP Community",
    category: "search-data",
    description:
      "One-click zero-key connection to fetch any web page as model-friendly text inside agent runs.",
    unlocks: "fetch tool for retrieving web pages as model-friendly text.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#22d3ee",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    libraryConnectorId: "fetch",
    fields: [],
  },
  {
    id: "arxiv",
    name: "arXiv",
    vendor: "arXiv",
    category: "search-data",
    description:
      "One-click zero-key connection to search arXiv papers and download readable content.",
    unlocks:
      "search_papers, get_abstract, download_paper, list_papers, and read_paper tools for research.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#b31b1b",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.blazickjp%2Farxiv-mcp-server/versions/latest",
    libraryConnectorId: "arxiv",
    fields: [],
  },
  {
    id: "youtube-transcripts",
    name: "YouTube Transcripts",
    vendor: "FetchWorks",
    category: "search-data",
    description:
      "Connect Apify to retrieve transcripts from YouTube videos and channels inside agent runs.",
    unlocks: "YouTube video and channel transcript retrieval tools in agent runs.",
    badges: ["MCP", "API Key"],
    accent: "#ff0000",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.fetchworks-dev%2Fyoutube-transcripts/versions/latest",
    libraryConnectorId: "youtube-transcripts",
    fields: [
      {
        key: "APIFY_TOKEN",
        label: "Apify API token",
        placeholder: "apify_api_…",
        secret: true,
        required: true,
        helpUrl: "https://console.apify.com/account/integrations",
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    vendor: "Notion",
    category: "productivity",
    description:
      "Connect Notion to let agents search and edit your workspace content. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Notion workspace search and edit tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#e4e4e7",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/com.notion%2Fmcp/versions/latest",
    libraryConnectorId: "notion",
    fields: [],
  },
  {
    id: "linear",
    name: "Linear",
    vendor: "Linear",
    category: "productivity",
    description:
      "Connect Linear to let agents manage issues, projects, and team workflows. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Linear issue, project, and team workflow tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#5e6ad2",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/app.linear%2Flinear/versions/latest",
    libraryConnectorId: "linear",
    fields: [],
  },
  {
    id: "atlassian",
    name: "Atlassian Rovo",
    vendor: "Atlassian",
    category: "productivity",
    description:
      "Connect Atlassian Rovo to let agents work with Jira issues and Confluence content. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Jira issue and Confluence content tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#2684ff",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/com.atlassian%2Fatlassian-mcp-server/versions/latest",
    libraryConnectorId: "atlassian",
    fields: [],
  },
  {
    id: "todoist",
    name: "Todoist",
    vendor: "Todoist",
    category: "productivity",
    description:
      "Connect Todoist to let agents work with your tasks and projects. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Todoist task and project search/fetch tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#e44332",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/net.todoist%2Fmcp/versions/latest",
    libraryConnectorId: "todoist",
    fields: [],
  },
  {
    id: "obsidian",
    name: "Obsidian",
    vendor: "Obsidian",
    category: "productivity",
    description: "Connect your Obsidian vault so agents can search, read, and edit notes.",
    unlocks:
      "obsidian_get_note, obsidian_list_notes, obsidian_search_notes, obsidian_write_note, and obsidian_append_to_note tools for your vault.",
    badges: ["MCP", "API Key"],
    accent: "#a68af9",
    docsUrl: "https://github.com/cyanheads/obsidian-mcp-server",
    libraryConnectorId: "obsidian",
    fields: [
      {
        key: "OBSIDIAN_API_KEY",
        label: "Obsidian API key",
        placeholder: "Obsidian Local REST API key",
        secret: true,
        required: true,
        hint: "From the Local REST API plugin in Obsidian; the vault must be open for the server to reach it.",
        helpUrl: "https://github.com/cyanheads/obsidian-mcp-server",
      },
    ],
  },
  {
    id: "discord",
    name: "Discord",
    vendor: "Discord",
    category: "productivity",
    description:
      "Connect Discord via a least-privilege bot so agents can read and post in your servers.",
    unlocks: "Discord access via a least-privilege bot inside agent runs.",
    badges: ["MCP", "Bot"],
    accent: "#5865f2",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.j-256%2Fdiscord-mcp/versions/latest",
    libraryConnectorId: "discord",
    fields: [
      {
        key: "DISCORD_BOT_TOKEN",
        label: "Discord bot token",
        placeholder: "Bot token from the Discord developer portal",
        secret: true,
        required: true,
        helpUrl: "https://discord.com/developers/applications",
      },
      {
        key: "DISCORD_MCP_CONFIG",
        label: "Discord MCP config file path (in the VM)",
        placeholder: "/workspace/discord-mcp.json",
        secret: false,
        required: true,
        hint: "Path inside the agent VM to the discord-mcp JSON config file listing the servers the bot may join.",
        helpUrl:
          "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.j-256%2Fdiscord-mcp/versions/latest",
      },
    ],
  },
  {
    id: "time",
    name: "Time",
    vendor: "MCP Community",
    category: "productivity",
    description: "One-click zero-key connection for current time and time-zone conversion tools.",
    unlocks: "get_current_time and convert_time tools for time zones.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#f59e0b",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    libraryConnectorId: "time",
    fields: [],
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    vendor: "MCP Community",
    category: "productivity",
    description: "One-click zero-key connection for structured multi-step reasoning tools.",
    unlocks: "sequentialthinking tool for structured multi-step reasoning.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#8b5cf6",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    libraryConnectorId: "sequential-thinking",
    fields: [],
  },
  {
    id: "memory",
    name: "Memory",
    vendor: "MCP Community",
    category: "productivity",
    description:
      "One-click zero-key connection for a persistent knowledge graph your agents share across sessions.",
    unlocks:
      "create_entities, create_relations, add_observations, search_nodes, open_nodes, and read_graph tools that persist across sessions.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#ec4899",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    libraryConnectorId: "memory",
    fields: [],
  },
  {
    id: "docker",
    name: "Docker",
    vendor: "Docker",
    category: "devops",
    description:
      "One-click zero-key connection to inspect and manage Docker containers and images from agent runs.",
    unlocks: "Docker container and image inspection tools (container_stop, container_restart, container_remove).",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#2496ed",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.L337-org%2Fdocker-mcp-server/versions/latest",
    libraryConnectorId: "docker",
    fields: [],
  },
  {
    id: "kubernetes",
    name: "Kubernetes",
    vendor: "Kubernetes",
    category: "devops",
    description:
      "One-click zero-key connection to inspect and manage Kubernetes and OpenShift resources.",
    unlocks: "Kubernetes and OpenShift resource inspection and management tools.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#326ce5",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.containers%2Fkubernetes-mcp-server/versions/latest",
    libraryConnectorId: "kubernetes",
    fields: [],
  },
  {
    id: "sentry",
    name: "Sentry",
    vendor: "Sentry",
    category: "devops",
    description:
      "Connect Sentry to let agents investigate errors and production issues. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Sentry error and production-issue investigation tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#362d59",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.getsentry%2FSentry-mcp/versions/latest",
    libraryConnectorId: "sentry",
    fields: [],
  },
  {
    id: "supabase",
    name: "Supabase",
    vendor: "Supabase",
    category: "devops",
    description:
      "Connect Supabase to let agents manage projects and database workflows. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Supabase project and database workflow tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#3ecf8e",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/com.supabase%2Fmcp/versions/latest",
    libraryConnectorId: "supabase",
    fields: [],
  },
  {
    id: "stripe",
    name: "Stripe",
    vendor: "Stripe",
    category: "devops",
    description:
      "Connect Stripe to let agents access payment and billing operations. Sign in with OAuth the first time your agent uses it.",
    unlocks: "Stripe payment and billing operation tools in agent runs.",
    badges: ["MCP", "OAuth"],
    accent: "#635bff",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/com.stripe%2Fmcp/versions/latest",
    libraryConnectorId: "stripe",
    fields: [],
  },
  {
    id: "git",
    name: "Git",
    vendor: "MCP Community",
    category: "devops",
    description:
      "One-click zero-key connection to inspect local Git repositories (status, diff, log) from agent runs.",
    unlocks: "git_status, git_diff_unstaged, git_diff_staged, git_log, and git_show tools for local repositories.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#f05033",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    libraryConnectorId: "git",
    fields: [],
  },
  {
    id: "playwright",
    name: "Playwright",
    vendor: "Microsoft",
    category: "devops",
    description:
      "One-click zero-key connection to automate and inspect browser interactions with Playwright.",
    unlocks:
      "browser_navigate, browser_click, browser_snapshot, and browser_take_screenshot tools for agent-driven browsing.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#2ead33",
    docsUrl:
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.microsoft%2Fplaywright-mcp/versions/latest",
    libraryConnectorId: "playwright",
    fields: [],
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    vendor: "Google",
    category: "devops",
    description:
      "One-click zero-key connection to automate browser navigation and screenshots with Puppeteer.",
    unlocks:
      "puppeteer_navigate, puppeteer_screenshot, puppeteer_click, puppeteer_hover, puppeteer_fill, and puppeteer_select tools.",
    badges: ["MCP", "1-Click", "Zero Key"],
    isFree: true,
    accent: "#40b5a4",
    docsUrl: "https://github.com/modelcontextprotocol/servers/issues/4785",
    libraryConnectorId: "puppeteer",
    fields: [],
  },
];

export function findCatalogConnector(id: string): ConnectorCatalogEntry | null {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id) ?? null;
}
