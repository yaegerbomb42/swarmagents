import type { CapabilityEntry } from "../schema";
import { CURATED_CLI_MANIFEST } from "../discovery/cli-manifest";

const cliEntries: CapabilityEntry[] = CURATED_CLI_MANIFEST.map((t) => ({
  id: `cli:${t.name}`,
  kind: "cli",
  name: t.name,
  summary: t.summary,
  risk: t.risk,
  schema: { binary: `/usr/local/bin/${t.name}` },
  source: "cli:PATH",
}));

const mcpEntries: CapabilityEntry[] = [
  {
    id: "mcp:filesystem:tool:read_file",
    kind: "mcp_tool",
    name: "filesystem/read_file",
    summary: "Read complete contents of a local file from disk",
    risk: "read-only",
    source: "mcp:claude-desktop:filesystem",
  },
  {
    id: "mcp:github:tool:create_pull_request",
    kind: "mcp_tool",
    name: "github/create_pull_request",
    summary: "Open a new GitHub pull request with title, body, and branch",
    risk: "network",
    source: "mcp:cursor:github",
  },
  {
    id: "mcp:postgres:tool:query",
    kind: "mcp_tool",
    name: "postgres/query",
    summary: "Run read-only SQL queries against the configured PostgreSQL database",
    risk: "read-only",
    source: "mcp:vscode:postgres",
  },
  {
    id: "mcp:slack:tool:post_message",
    kind: "mcp_tool",
    name: "slack/post_message",
    summary: "Send a chat message to a Slack channel or thread",
    risk: "network",
    source: "mcp:claude-desktop:slack",
  },
  {
    id: "mcp:playwright:tool:navigate",
    kind: "mcp_tool",
    name: "playwright/navigate",
    summary: "Open a URL in a headless browser and take screenshots or scrape DOM",
    risk: "network",
    source: "mcp:claude-code:playwright",
  },
];

const appEntries: CapabilityEntry[] = [
  {
    id: "app:obsidian",
    kind: "desktop_app",
    name: "Obsidian",
    summary: "Markdown knowledge base and note-taking app [scriptable]",
    risk: "writes-files",
    source: "apps:macos",
  },
  {
    id: "app:visual-studio-code",
    kind: "desktop_app",
    name: "Visual Studio Code",
    summary: "Code editor and IDE with extensions [scriptable]",
    risk: "writes-files",
    source: "apps:macos",
  },
];

const providerEntries: CapabilityEntry[] = [
  {
    id: "provider:openai",
    kind: "ai_provider",
    name: "OpenAI",
    summary: "OpenAI API key configured via OPENAI_API_KEY (ok)",
    risk: "network",
    source: "env:OPENAI_API_KEY",
  },
  {
    id: "provider:anthropic",
    kind: "ai_provider",
    name: "Anthropic",
    summary: "Anthropic API key configured via ANTHROPIC_API_KEY (ok)",
    risk: "network",
    source: "env:ANTHROPIC_API_KEY",
  },
];

export const FIXTURE_MACHINE_CAPABILITIES: CapabilityEntry[] = [
  ...cliEntries,
  ...mcpEntries,
  ...appEntries,
  ...providerEntries,
];
