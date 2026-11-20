/**
 * Which files did the agent touch?
 *
 * The heatmap weighs the files this account's agent worked on before, so the
 * harness has to know which paths a tool call referred to. The tool calls are
 * Claude Code's (Write, Edit, Read, Bash, ...) and their argument shape
 * differs per tool, so the paths are collected defensively: anything that
 * looks like a workspace path is counted, and nothing else is.
 */

const PATH_KEYS = new Set([
  "path",
  "file",
  "file_path",
  "filepath",
  "filePath",
  "filename",
  "fileName",
  "target",
  "target_path",
  "targetPath",
  "uri",
  "notebook_path",
  "notebookPath",
]);

/** Normalize a path the agent mentioned into a workspace-relative path. */
export function normalizeTouchedPath(raw: string): string | null {
  let value = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!value) return null;
  value = value.replace(/^file:\/\//, "");
  const marker = "/workspace/";
  const index = value.indexOf(marker);
  if (index >= 0) value = value.slice(index + marker.length);
  else if (value.startsWith("/workspace")) value = value.slice("/workspace".length).replace(/^\/+/, "");
  else if (value.startsWith("./")) value = value.slice(2);
  if (!value || value.startsWith("/") || value.includes("..")) return null;
  return value;
}

/** The file names a shell command mentions. */
function pathsFromCommand(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s"'`])((?:\/workspace\/)?[A-Za-z0-9_.@/-]+\.[A-Za-z0-9_-]{1,12})(?=[\s"'`:;,]|$)/g;
  for (const match of command.matchAll(re)) out.push(match[1]);
  return out;
}

/** Collect the workspace-relative paths a tool call refers to. */
export function extractTouchedPaths(input: unknown): string[] {
  const out = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = normalizeTouchedPath(value);
    if (normalized) out.add(normalized);
  };

  const scan = (value: unknown, depth = 0): void => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value) scan(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "string" && PATH_KEYS.has(key)) push(item);
      else if (key === "command" && typeof item === "string") {
        for (const candidate of pathsFromCommand(item)) push(candidate);
      } else scan(item, depth + 1);
    }
  };

  scan(input);
  return [...out];
}
