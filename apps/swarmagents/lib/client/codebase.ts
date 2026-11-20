/** Client helpers for the codebase map API. */

export interface CodebaseHotspot {
  path: string;
  churn90d: number;
  bytes: number;
  fanIn: number;
  agentTouches: number;
  heat: number;
  /**
   * Optional — added server-side by the F7 server work. The UI treats both
   * as possibly absent: complexity falls back to churn, and a missing
   * coverage (`undefined` or `null`) means the repo has no coverage
   * artifact, never 0% coverage.
   */
  complexity?: number;
  coveragePct?: number | null;
}

export interface CodebaseModule {
  path: string;
  kind?: "dir" | "file";
  purpose: string;
  files: number;
  bytes: number;
}

export interface CodebaseRepo {
  /** Workspace-relative path ("" is the workspace root itself). */
  repo: string;
  /** Absolute path inside the VM. */
  repoRoot: string;
  name: string;
}

export interface CodebaseMapSummary {
  repoRoot: string;
  repoName: string;
  repoHash: string;
  generatedAt?: string;
  gitHead?: string;
  buildMs?: number;
  fileCount: number;
  tokenEstimate: number;
  languages?: Record<string, number>;
  entryPoints?: string[];
  buildCommands?: string[];
  testCommands?: string[];
  conventions?: Record<string, unknown>;
  topLevelModules?: CodebaseModule[];
  heatmap?: CodebaseHotspot[];
  contextPack?: { tokenEstimate: number; text: string };
}

export interface CodebaseApiResponse {
  ok: boolean;
  map?: CodebaseMapSummary;
  repos?: CodebaseRepo[];
  selected?: string | null;
  error?: string;
}

export type CodebaseStrikeAction = "refactor" | "tests" | "explain";

export interface CodebaseStrikeResponse {
  ok: boolean;
  runId: string;
  queued: boolean;
  position?: number;
  sliceTokenEstimate: number;
  error?: string;
}

/**
 * Start a scoped run against one hotspot: the file or top-level module at
 * `path` plus its direct imports and importers, and nothing else.
 */
export async function strikeCodebaseModule(
  repo: string,
  path: string,
  action: CodebaseStrikeAction,
): Promise<CodebaseStrikeResponse> {
  const res = await fetch("/api/runtime/codebase/strike", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, path, action }),
  });
  const data = (await res.json().catch(() => ({}))) as CodebaseStrikeResponse;
  if (!res.ok) throw new Error(data.error || `codebase strike failed (${res.status})`);
  return data;
}

/** The map of the given repository (empty string = the workspace root). */
export async function fetchCodebaseMap(repo = "", n = 60): Promise<CodebaseApiResponse> {
  const query = new URLSearchParams({ repo, n: String(n) });
  const res = await fetch(`/api/runtime/codebase?${query.toString()}`, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as CodebaseApiResponse;
  if (!res.ok) throw new Error(data.error || `codebase map failed (${res.status})`);
  if (!data.map && data.error) throw new Error(data.error);
  return data;
}

/** The repositories in the user's workspace and the one that is picked. */
export async function fetchCodebaseRepos(): Promise<{ repos: CodebaseRepo[]; selected: string | null }> {
  const res = await fetch("/api/runtime/codebase?list=1", { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as CodebaseApiResponse;
  if (!res.ok) throw new Error(data.error || `codebase repos failed (${res.status})`);
  return { repos: Array.isArray(data.repos) ? data.repos : [], selected: data.selected ?? null };
}

/**
 * Pick a repository: its map is built (when it is missing) and its context
 * pack is injected into every run on it.
 */
export async function pickCodebaseRepo(repo = "", force = false): Promise<CodebaseApiResponse> {
  const res = await fetch("/api/runtime/codebase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, force }),
  });
  const data = (await res.json().catch(() => ({}))) as CodebaseApiResponse;
  if (!res.ok) throw new Error(data.error || `codebase rebuild failed (${res.status})`);
  return data;
}
