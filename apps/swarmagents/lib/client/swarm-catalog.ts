import { LibraryApiError, libraryApi, type ConnectorEntry, type InstalledItem } from "./library";
import frontendDesign from "../library/catalog/skills/frontend-design.json";
import internalComms from "../library/catalog/skills/internal-comms.json";
import { normalizePayload, type LibraryKind, type LibraryPayload } from "../library/types";
import { PROVIDER_CATALOG } from "../providers/catalog";

export const CATALOG_CATEGORIES = {
  code: "Code",
  browser: "Browser & web",
  files: "Files",
  data: "Data",
  comms: "Communications",
  design: "Design",
  models: "Models",
} as const;

export type CatalogCategory = keyof typeof CATALOG_CATEGORIES;
export const PROVIDER_SETTINGS_URL = "/providers";

export type CatalogAdd =
  | { via: "provider-settings" }
  | { via: "connector"; connectorId: string; fields: ConnectorEntry["requiredFields"] }
  | { via: "library"; payload: LibraryPayload; license?: string };

export interface SwarmCatalogEntry {
  id: string;
  name: string;
  kind: LibraryKind;
  category: CatalogCategory;
  vendor: string;
  description: string;
  unlocks: string;
  setup: string;
  sourceUrl: string;
  add: CatalogAdd;
  installed: boolean;
}

type ConnectorListing = Pick<SwarmCatalogEntry, "kind" | "category" | "vendor" | "unlocks" | "setup">;

// The Library owns the transport, command, source and credential field names.
// The catalog only selects vetted entries that the existing run config can use.
const CONNECTOR_LISTINGS: Readonly<Record<string, ConnectorListing>> = {
  "github-read-only": {
    kind: "connector",
    category: "code",
    vendor: "GitHub",
    unlocks: "Read repository content, issues and pull requests within the token's permissions.",
    setup: "Requires a GitHub token. Grant read access only to the repositories you want your swarm to see.",
  },
  exa: {
    kind: "connector",
    category: "browser",
    vendor: "Exa",
    unlocks: "Find relevant web pages and retrieve text for research.",
    setup: "No key needed. Exa's public endpoint is rate-limited and receives your search queries.",
  },
  "brave-search": {
    kind: "connector",
    category: "browser",
    vendor: "Brave",
    unlocks: "Search the web, news, images and other index results from a tool-capable run.",
    setup: "Requires a Brave Search API key. Brave's usage limits and billing apply.",
  },
  "openai-docs": {
    kind: "mcp",
    category: "code",
    vendor: "OpenAI",
    unlocks: "Look up API parameters, examples and current product guidance directly from OpenAI's docs.",
    setup: "No key needed. This server reads documentation only; it does not call the OpenAI API on your behalf.",
  },
  "postgres-dbhub": {
    kind: "mcp",
    category: "data",
    vendor: "Bytebase",
    unlocks: "Find database objects and query PostgreSQL from the VM.",
    setup: "Requires a PostgreSQL connection string reachable from your VM. Use a read-only database role; the server can otherwise write.",
  },
  "sqlite-read-only": {
    kind: "mcp",
    category: "data",
    vendor: "djgadd",
    unlocks: "List tables, inspect schemas and run read-only SQL against SQLite files.",
    setup: "No key needed. Give the agent the absolute path of a database inside your VM.",
  },
};

const MODEL_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "gemini", "xai"]);

type BundledListing = Omit<SwarmCatalogEntry, "installed" | "add"> & {
  add: Extract<CatalogAdd, { via: "library" }>;
};

const BUNDLED_LISTINGS: readonly BundledListing[] = [
  {
    id: "skill:frontend-design",
    name: "Frontend Design",
    kind: "skill",
    category: "design",
    vendor: "Anthropic",
    description: "Give agents a design workflow for building distinctive, production-ready interfaces.",
    unlocks: "Guide layout, type, color and interaction choices when the agent builds web interfaces.",
    setup: "No key or extra install needed. Adds Anthropic's versioned SKILL.md to your VM on the next run.",
    sourceUrl: frontendDesign.sourceUrl,
    add: { via: "library", payload: normalizePayload("skill", frontendDesign), license: frontendDesign.license },
  },
  {
    id: "skill:internal-comms",
    name: "Internal Communications",
    kind: "skill",
    category: "comms",
    vendor: "Anthropic",
    description: "Draft internal status reports, FAQs, project updates and newsletters.",
    unlocks: "Give your agent concrete formats and examples for team communications. The skill drafts, but does not send, messages.",
    setup: "No key or extra install needed. The skill and its example files are copied into your VM on the next run.",
    sourceUrl: internalComms.sourceUrl,
    add: { via: "library", payload: normalizePayload("skill", internalComms), license: internalComms.license },
  },
  {
    id: "tool:format-json",
    name: "JSON Formatter",
    kind: "tool",
    category: "files",
    vendor: "SwarmAgents · JavaScript",
    description: "Validate and pretty-print JSON text without sending it to a service.",
    unlocks: "Turn compact JSON into readable text, or get a clear error if the input is not JSON.",
    setup: "No key needed. Uses JavaScript's native JSON functions inside your VM; it does not read or modify files.",
    sourceUrl: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify",
    add: {
      via: "library",
      payload: normalizePayload("tool", {
        language: "javascript",
        code: `if (typeof args?.text !== "string" || args.text.length > 20000) {
  return { error: "Provide JSON text of at most 20,000 characters." };
}
try {
  return { formatted: JSON.stringify(JSON.parse(args.text), null, 2) };
} catch {
  return { error: "The input is not valid JSON." };
}`,
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", maxLength: 20000, description: "JSON text to format" } },
          required: ["text"],
          additionalProperties: false,
        },
        requiredFields: [],
        timeoutMs: 5000,
      }),
    },
  },
];

interface ProviderStatus {
  id: string;
  connected: boolean;
}

export function buildSwarmCatalog(
  connectors: readonly ConnectorEntry[],
  providerStatus: readonly ProviderStatus[],
  installed: readonly InstalledItem[],
): SwarmCatalogEntry[] {
  const byId = new Map(connectors.map((entry) => [entry.id, entry]));
  const entries: SwarmCatalogEntry[] = [];
  for (const [id, listing] of Object.entries(CONNECTOR_LISTINGS)) {
    const connector = byId.get(id);
    if (!connector?.verified || !connector.canInstall || !connector.sourceUrl?.startsWith("https://")) continue;
    if (connector.auth !== "none" && (connector.auth !== "token" || connector.requiredFields.length === 0)) continue;
    entries.push({
      ...listing,
      id: `connector:${id}`,
      name: connector.name,
      description: connector.description,
      sourceUrl: connector.sourceUrl,
      add: { via: "connector", connectorId: id, fields: connector.requiredFields },
      installed: connector.installed === true,
    });
  }
  for (const provider of PROVIDER_CATALOG) {
    const sourceUrl = provider.links.docs;
    if (!MODEL_PROVIDERS.has(provider.id) || !sourceUrl) continue;
    entries.push({
      id: `provider:${provider.id}`,
      name: provider.name,
      kind: "connector",
      category: "models",
      vendor: provider.name,
      description: provider.shortDescription,
      unlocks: `Use ${provider.name} models through the swarm's provider routing settings. Hosted tools are not enabled by adding a model provider.`,
      setup: "Add your API key in Provider Settings. Keys are stored in your account, not in the catalog.",
      sourceUrl,
      add: { via: "provider-settings" },
      installed: providerStatus.some((row) => row.id === provider.id && row.connected),
    });
  }
  entries.push(...BUNDLED_LISTINGS.map((entry) => ({
    ...entry,
    // The custom item endpoint assigns ids. Match the installed payload, not
    // just the display name (which is also available to user-authored items).
    installed: installed.some((item) => item.kind === entry.kind && item.name === entry.name
      && JSON.stringify(item.payload) === JSON.stringify(entry.add.payload)),
  })));
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function filterSwarmCatalog(
  entries: readonly SwarmCatalogEntry[],
  query: string,
  kind: LibraryKind | "all",
  category: CatalogCategory | "all",
): SwarmCatalogEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (kind !== "all" && entry.kind !== kind) return false;
    if (category !== "all" && entry.category !== category) return false;
    const text = [entry.name, entry.vendor, entry.description, entry.unlocks, CATALOG_CATEGORIES[entry.category]]
      .join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

async function getProviderStatus(): Promise<ProviderStatus[]> {
  const response = await fetch("/api/providers", { cache: "no-store" });
  if (!response.ok) throw new LibraryApiError("Could not load provider settings.", response.status);
  const body = await response.json() as { catalog?: ProviderStatus[] };
  if (!Array.isArray(body.catalog)) throw new Error("Invalid provider catalog response.");
  return body.catalog;
}

export async function loadSwarmCatalog(): Promise<SwarmCatalogEntry[]> {
  const [connectors, providers, installed] = await Promise.all([
    libraryApi.connectors(), getProviderStatus(), libraryApi.listItems(),
  ]);
  if (!Array.isArray(connectors.connectors) || !Array.isArray(installed.items)) {
    throw new Error("Invalid library catalog response.");
  }
  return buildSwarmCatalog(connectors.connectors, providers, installed.items);
}

function connectorValues(
  action: Extract<CatalogAdd, { via: "connector" }>,
  inputs: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(action.fields.map((field) => {
    const value = inputs[field.key]?.trim();
    if (!value) throw new LibraryApiError(`${field.label} is required.`, 400);
    if (action.connectorId === "github-read-only" && field.key === "Authorization") {
      const token = value.replace(/^Bearer\s+/i, "");
      if (!token || /\s/.test(token)) throw new LibraryApiError("Enter a GitHub token without spaces.", 400);
      return [field.key, `Bearer ${token}`];
    }
    if (action.connectorId === "postgres-dbhub" && field.key === "DSN") {
      try {
        const url = new URL(value);
        if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname || url.pathname.length < 2) throw new Error();
      } catch {
        throw new LibraryApiError("Enter a postgres:// or postgresql:// connection string with a host and database.", 400);
      }
    }
    return [field.key, value];
  }));
}

export async function addSwarmCatalogEntry(
  entry: SwarmCatalogEntry,
  inputs: Readonly<Record<string, string>> = {},
): Promise<InstalledItem> {
  if (entry.installed) throw new LibraryApiError("This item is already added.", 409);
  const action = entry.add;
  if (action.via === "provider-settings") throw new LibraryApiError("Connect this provider in Provider Settings.", 400);
  const response = action.via === "connector"
    ? await libraryApi.addConnector(action.connectorId, connectorValues(action, inputs))
    : await libraryApi.addItem({ kind: entry.kind, name: entry.name, description: entry.description, license: action.license, payload: action.payload });
  if (!response.item?.id) throw new Error("Invalid library install response.");
  return response.item;
}
