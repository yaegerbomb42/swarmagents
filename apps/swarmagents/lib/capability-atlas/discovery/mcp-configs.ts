import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type McpClientName =
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "opencode"
  | "claude-code";

export interface McpServerConfig {
  name: string;
  client: McpClientName;
  sourcePath: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ConfigPathCandidate {
  client: McpClientName;
  filePath: string;
}

export function getMcpConfigPaths(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd()
): ConfigPathCandidate[] {
  const appData =
    process.env.APPDATA ?? path.join(homeDir, "AppData", "Roaming");
  const xdgConfig =
    process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");

  const candidates: ConfigPathCandidate[] = [];

  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    candidates.push(
      {
        client: "claude-desktop",
        filePath: path.join(appSupport, "Claude", "claude_desktop_config.json"),
      },
      {
        client: "cursor",
        filePath: path.join(homeDir, ".cursor", "mcp.json"),
      },
      {
        client: "vscode",
        filePath: path.join(appSupport, "Code", "User", "mcp.json"),
      },
      {
        client: "vscode",
        filePath: path.join(cwd, ".vscode", "mcp.json"),
      },
      {
        client: "windsurf",
        filePath: path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
      },
      {
        client: "opencode",
        filePath: path.join(xdgConfig, "opencode", "opencode.json"),
      },
      {
        client: "opencode",
        filePath: path.join(cwd, "opencode.json"),
      },
      {
        client: "claude-code",
        filePath: path.join(homeDir, ".claude.json"),
      },
      {
        client: "claude-code",
        filePath: path.join(cwd, ".mcp.json"),
      }
    );
  } else if (platform === "win32") {
    candidates.push(
      {
        client: "claude-desktop",
        filePath: path.join(appData, "Claude", "claude_desktop_config.json"),
      },
      {
        client: "cursor",
        filePath: path.join(homeDir, ".cursor", "mcp.json"),
      },
      {
        client: "vscode",
        filePath: path.join(appData, "Code", "User", "mcp.json"),
      },
      {
        client: "vscode",
        filePath: path.join(cwd, ".vscode", "mcp.json"),
      },
      {
        client: "windsurf",
        filePath: path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
      },
      {
        client: "opencode",
        filePath: path.join(appData, "opencode", "opencode.json"),
      },
      {
        client: "opencode",
        filePath: path.join(cwd, "opencode.json"),
      },
      {
        client: "claude-code",
        filePath: path.join(homeDir, ".claude.json"),
      },
      {
        client: "claude-code",
        filePath: path.join(cwd, ".mcp.json"),
      }
    );
  } else {
    candidates.push(
      {
        client: "claude-desktop",
        filePath: path.join(xdgConfig, "Claude", "claude_desktop_config.json"),
      },
      {
        client: "cursor",
        filePath: path.join(homeDir, ".cursor", "mcp.json"),
      },
      {
        client: "vscode",
        filePath: path.join(xdgConfig, "Code", "User", "mcp.json"),
      },
      {
        client: "vscode",
        filePath: path.join(cwd, ".vscode", "mcp.json"),
      },
      {
        client: "windsurf",
        filePath: path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
      },
      {
        client: "opencode",
        filePath: path.join(xdgConfig, "opencode", "opencode.json"),
      },
      {
        client: "opencode",
        filePath: path.join(cwd, "opencode.json"),
      },
      {
        client: "claude-code",
        filePath: path.join(homeDir, ".claude.json"),
      },
      {
        client: "claude-code",
        filePath: path.join(cwd, ".mcp.json"),
      }
    );
  }

  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseServerEntry(
  name: string,
  raw: unknown,
  client: McpClientName,
  sourcePath: string
): McpServerConfig | null {
  if (!isRecord(raw)) return null;
  if (raw.enabled === false || raw.disabled === true) return null;

  // OpenCode uses command: string[] and type: "local" | "remote"
  if (Array.isArray(raw.command) && typeof raw.command[0] === "string") {
    const [cmd, ...rest] = raw.command.filter(
      (x): x is string => typeof x === "string"
    );
    if (!cmd) return null;
    return {
      name,
      client,
      sourcePath,
      transport: "stdio",
      command: cmd,
      args: rest,
      env: toStringRecord(raw.environment ?? raw.env),
    };
  }

  if (typeof raw.command === "string" && raw.command.length > 0) {
    const args = Array.isArray(raw.args)
      ? raw.args.filter((x): x is string => typeof x === "string")
      : [];
    return {
      name,
      client,
      sourcePath,
      transport: "stdio",
      command: raw.command,
      args,
      env: toStringRecord(raw.env),
    };
  }

  const url =
    typeof raw.url === "string"
      ? raw.url
      : typeof raw.serverUrl === "string"
        ? raw.serverUrl
        : undefined;

  if (url && /^https?:\/\//i.test(url)) {
    return {
      name,
      client,
      sourcePath,
      transport: "http",
      url,
      headers: toStringRecord(raw.headers),
    };
  }

  return null;
}

export function parseMcpConfigContent(
  content: string,
  client: McpClientName,
  sourcePath: string
): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  const serverMaps: Record<string, unknown>[] = [];
  if (isRecord(parsed.mcpServers)) serverMaps.push(parsed.mcpServers);
  if (isRecord(parsed.servers)) serverMaps.push(parsed.servers);
  if (isRecord(parsed.mcp)) serverMaps.push(parsed.mcp);

  // Claude Code ~/.claude.json can also nest mcpServers under projects[path]
  if (isRecord(parsed.projects)) {
    for (const proj of Object.values(parsed.projects)) {
      if (isRecord(proj) && isRecord(proj.mcpServers)) {
        serverMaps.push(proj.mcpServers);
      }
    }
  }

  const results: McpServerConfig[] = [];
  const seen = new Set<string>();

  for (const map of serverMaps) {
    for (const [name, raw] of Object.entries(map)) {
      const entry = parseServerEntry(name, raw, client, sourcePath);
      if (entry && !seen.has(entry.name)) {
        seen.add(entry.name);
        results.push(entry);
      }
    }
  }

  return results;
}

export async function discoverMcpConfigs(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd()
): Promise<McpServerConfig[]> {
  const candidates = getMcpConfigPaths(platform, homeDir, cwd);
  const all: McpServerConfig[] = [];
  const dedup = new Set<string>();

  for (const { client, filePath } of candidates) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const servers = parseMcpConfigContent(content, client, filePath);
      for (const s of servers) {
        const key = `${s.name}:${s.command ?? s.url ?? ""}`;
        if (!dedup.has(key)) {
          dedup.add(key);
          all.push(s);
        }
      }
    } catch {
      // File missing or unreadable; skip silently
    }
  }

  return all;
}
