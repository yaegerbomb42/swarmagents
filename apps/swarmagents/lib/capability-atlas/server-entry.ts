/**
 * In-VM atlas query server program source.
 *
 * This file is NOT imported by the app at runtime. It is bundled by
 * `generate-server-source.ts` into `lib/harness/atlas-mcp-source.ts`,
 * whose output is written verbatim into the user's VM as the
 * `capability-atlas` MCP stdio server. Keep it dependency-free apart
 * from node builtins and the retrieval modules: the generator refuses
 * any other import. The registry path comes from SWARM_ATLAS_REGISTRY
 * (set by the harness MCP config); without it, the server reads the
 * per-user default under $HOME — never a shared path, never key values.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CapabilityRetriever } from "./retrieval/index";
import type { CapabilityEntry } from "./schema";

const KINDS = new Set([
  "mcp_tool",
  "mcp_resource",
  "mcp_prompt",
  "cli",
  "desktop_app",
  "ai_provider",
]);
const RISKS = new Set(["read-only", "writes-files", "network", "destructive"]);

type PublicEntry = Pick<
  CapabilityEntry,
  "id" | "kind" | "name" | "summary" | "risk" | "source"
>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toPublicEntry(v: unknown): PublicEntry | null {
  if (!isRecord(v)) return null;
  const { id, kind, name, summary, risk, source } = v;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof kind !== "string" ||
    !KINDS.has(kind) ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof summary !== "string" ||
    summary.length === 0 ||
    typeof risk !== "string" ||
    !RISKS.has(risk) ||
    typeof source !== "string" ||
    source.length === 0
  ) {
    return null;
  }
  return {
    id,
    kind: kind as PublicEntry["kind"],
    name,
    summary,
    risk: risk as PublicEntry["risk"],
    source,
  };
}

function loadRegistry(filePath: string): PublicEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    const out: PublicEntry[] = [];
    for (const e of parsed.entries) {
      const pub = toPublicEntry(e);
      if (pub) out.push(pub);
    }
    return out;
  } catch {
    return [];
  }
}

function defaultRegistryPath(): string {
  return path.join(process.env.HOME ?? "/root", ".swarm", "atlas", "registry.json");
}

const registryPath =
  process.argv[2] ?? process.env.SWARM_ATLAS_REGISTRY ?? defaultRegistryPath();
const entries = loadRegistry(registryPath);
const retriever = new CapabilityRetriever(entries);

function textResult(id: unknown, text: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })}\n`,
  );
}

function errorResult(id: unknown, code: number, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

const TOOLS = [
  {
    name: "find_capability",
    description:
      "Find capabilities (MCP tools, CLIs, apps, providers) matching a query. Returns compact id | kind | risk | summary lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "describe_capability",
    description: "Full discovery metadata for one capability by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(msg) || typeof msg.method !== "string") return;
  const id = msg.id ?? null;
  // Notifications (no id) need no reply.
  if (id === null && msg.method !== "initialize") return;

  if (msg.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "capability-atlas", version: "1.0.0" },
        },
      })}\n`,
    );
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: TOOLS } })}\n`,
    );
    return;
  }
  if (msg.method !== "tools/call") {
    errorResult(id, -32601, `method not found: ${msg.method}`);
    return;
  }
  const params = isRecord(msg.params) ? msg.params : {};
  const name = params.name;
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (name === "find_capability") {
    if (typeof args.query !== "string" || args.query.trim() === "") {
      errorResult(id, -32602, "find_capability requires a non-empty query string");
      return;
    }
    const k =
      typeof args.k === "number" && Number.isFinite(args.k)
        ? Math.min(10, Math.max(1, Math.floor(args.k)))
        : 5;
    textResult(id, retriever.formatCompact(retriever.find_capability(args.query, k)));
    return;
  }
  if (name === "describe_capability") {
    if (typeof args.id !== "string") {
      errorResult(id, -32602, "describe_capability requires an id string");
      return;
    }
    const entry = retriever.describe_capability(args.id);
    textResult(id, entry ? JSON.stringify(entry, null, 2) : "No such capability.");
    return;
  }
  errorResult(id, -32602, `unknown tool: ${String(name)}`);
});
