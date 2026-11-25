/**
 * Lazy-discovery client for the official Model Context Protocol (MCP) Registry.
 *
 * Queries https://registry.modelcontextprotocol.io/v0.1/servers on demand with
 * an in-memory TTL cache and returns compact summaries so agents and users can
 * discover hundreds of MCP servers without bloating prompt context.
 */

export interface RegistryMcpSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  transport: "http" | "stdio" | "unknown";
  url?: string;
  packageManager?: "npx" | "uvx";
  packageName?: string;
}

interface CacheEntry {
  expiresAt: number;
  results: RegistryMcpSummary[];
}

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1/servers";
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function summarizeServer(raw: Record<string, unknown>): RegistryMcpSummary | null {
  const srv = (raw.server as Record<string, unknown> | undefined) ?? raw;
  const name = typeof srv.name === "string" ? srv.name.trim() : "";
  if (!name) return null;

  const description =
    typeof srv.description === "string"
      ? srv.description.trim().slice(0, 160)
      : "";
  const version = typeof srv.version === "string" ? srv.version : "latest";

  let transport: RegistryMcpSummary["transport"] = "unknown";
  let url: string | undefined;
  let packageManager: "npx" | "uvx" | undefined;
  let packageName: string | undefined;
  const remotes = Array.isArray(srv.remotes) ? srv.remotes : [];
  if (remotes.length > 0 && typeof remotes[0] === "object" && remotes[0] !== null) {
    transport = "http";
    const remoteUrl = (remotes[0] as Record<string, unknown>).url;
    if (typeof remoteUrl === "string") url = remoteUrl;
  } else if (Array.isArray(srv.packages) && srv.packages.length > 0) {
    transport = "stdio";
    const pkg = srv.packages[0] as Record<string, unknown> | undefined;
    if (pkg && typeof pkg === "object") {
      const regType = typeof pkg.registryType === "string" ? pkg.registryType.toLowerCase() : "";
      const ident = typeof pkg.identifier === "string" ? pkg.identifier.trim() : "";
      if (ident) {
        packageName = ident;
        packageManager = regType === "pypi" ? "uvx" : "npx";
      }
    }
  }

  return { id: name, name, description, version, transport, url, packageManager, packageName };
}

export async function searchMcpRegistry(
  query: string,
  options: { limit?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RegistryMcpSummary[]> {
  const q = query.trim();
  const limit = Math.min(Math.max(options.limit ?? 15, 1), 50);
  const now = options.now ?? Date.now;
  const cacheKey = `${q.toLowerCase()}::${limit}`;

  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now()) {
    return hit.results;
  }

  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set("search", q);

  const fetchFn = options.fetchImpl ?? fetch;
  const res = await fetchFn(`${REGISTRY_BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`MCP registry returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as { servers?: unknown[] };
  const rows = Array.isArray(body.servers) ? body.servers : [];
  const results = rows
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map(summarizeServer)
    .filter((s): s is RegistryMcpSummary => s !== null);

  cache.set(cacheKey, { expiresAt: now() + CACHE_TTL_MS, results });
  return results;
}

export function clearMcpRegistryCache(): void {
  cache.clear();
}
