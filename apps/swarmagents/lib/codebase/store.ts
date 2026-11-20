/**
 * The codebase map store.
 *
 * One map per (account, repository). The map itself lives in the user's VM
 * (`~/.swarm/codebase/<repoHash>/map.json`), so the agent's MCP tools and the
 * app read the very same document; the server keeps a small in-memory cache
 * so a run does not rebuild the map on every turn.
 *
 * Freshness: a map is rebuilt when the repository's HEAD moves (someone
 * committed) or when the user asks for it explicitly. The map is never
 * rebuilt silently for a repository the account never picked.
 */

import { buildMapFromScan, selectHotspots } from "./analyze";
import { repoHashForRoot } from "./hash";
import { CONTEXT_PACK_TOKEN_BUDGET } from "./rules";
import type { CodebaseMap, CodebaseRepoOption, CodebaseScanner } from "./types";

/** Cache key: one map per account and repository. */
export function repoKey(userId: string, repoRoot: string): string {
  return `${userId}:${repoHashForRoot(repoRoot)}`;
}

const memory = new Map<string, CodebaseMap>();

/** Drop the cached map for an account (used by tests and by VM resets). */
export function forgetCodebaseMap(userId: string, repoRoot: string): void {
  memory.delete(repoKey(userId, repoRoot));
}

export interface EnsureOptions {
  repoRoot: string;
  /** Rebuild even when the cached map looks current. */
  force?: boolean;
}

/**
 * Return the map for a repository, building it the first time and rebuilding
 * it when the repository moved on. Never throws: a repository that cannot be
 * scanned simply has no map.
 */
export async function ensureCodebaseMap(
  userId: string,
  scanner: CodebaseScanner,
  options: EnsureOptions,
): Promise<CodebaseMap | null> {
  const repoRoot = options.repoRoot;
  const key = repoKey(userId, repoRoot);
  let cached = memory.get(key);
  if (!cached) {
    // A map published in an earlier process is still current when HEAD has
    // not moved: read it back instead of rescanning the repository.
    cached = (await scanner.readMap(userId, repoRoot).catch(() => null)) ?? undefined;
    if (cached) memory.set(key, cached);
  }

  if (!options.force && cached) {
    const head = await scanner.head(userId, repoRoot).catch(() => undefined);
    if (!head || !cached.gitHead || head === cached.gitHead) return cached;
  }

  const scan = await scanner
    .scan(userId, repoRoot, { sinceHead: cached?.gitHead })
    .catch(() => null);
  if (!scan) return cached ?? null;

  const touches: Record<string, number> = {};
  for (const file of cached?.files ?? []) {
    if (file.agentTouches) touches[file.path] = file.agentTouches;
  }

  const map = buildMapFromScan(scan, {
    repoRoot,
    tokenBudget: CONTEXT_PACK_TOKEN_BUDGET,
    agentTouchesByPath: touches,
  });

  memory.set(key, map);
  await scanner.publish(userId, repoRoot, map).catch(() => undefined);
  return map;
}

/** The context pack for a repository, already inside the token budget. */
export async function getCodebaseContextPack(
  userId: string,
  scanner: CodebaseScanner,
  repoRoot: string,
): Promise<CodebaseMap["contextPack"] | null> {
  const map = await ensureCodebaseMap(userId, scanner, { repoRoot });
  if (!map) return null;
  const pack = map.contextPack;
  if (pack.tokenEstimate <= CONTEXT_PACK_TOKEN_BUDGET) return pack;
  return { ...pack, tokenEstimate: CONTEXT_PACK_TOKEN_BUDGET };
}

/** The n hottest files of a repository. */
export async function getCodebaseHotspots(
  userId: string,
  scanner: CodebaseScanner,
  repoRoot: string,
  n = 20,
): Promise<ReturnType<typeof selectHotspots>> {
  const map = await ensureCodebaseMap(userId, scanner, { repoRoot });
  if (!map) return [];
  return selectHotspots(map, n);
}

/**
 * Remember which files this account's agent touched, so the heatmap can
 * show them. The counters live in the map, which lives in the account's own
 * VM: another account never sees them.
 *
 * Only files of a repository the account picked are counted, so a run never
 * builds a map behind the user's back.
 */
export async function recordAgentTouches(
  userId: string,
  scanner: CodebaseScanner,
  repoRoot: string,
  touchedPaths: string[],
): Promise<void> {
  if (touchedPaths.length === 0) return;
  const key = repoKey(userId, repoRoot);
  const map = memory.get(key);
  if (!map) return;

  const byPath = new Map(map.files.map((file) => [file.path, file]));
  let changed = false;
  for (const raw of touchedPaths) {
    const rel = normalizeRepoPath(raw, map.repoRoot);
    if (!rel) continue;
    const file = byPath.get(rel);
    if (!file) continue;
    file.agentTouches = (file.agentTouches ?? 0) + 1;
    changed = true;
  }
  if (!changed) return;

  const maxTouch = Math.max(1, ...map.files.map((file) => file.agentTouches ?? 0));
  const churnMax = Math.max(1, ...map.files.map((file) => file.churn90d ?? 0));
  const sizeMax = Math.max(1, ...map.files.map((file) => file.bytes ?? 0));
  const fanInMax = Math.max(1, ...map.files.map((file) => file.fanIn ?? 0));
  for (const entry of map.heatmap) {
    const file = byPath.get(entry.path);
    const touches = file?.agentTouches ?? 0;
    entry.agentTouches = touches;
    entry.heat = Number(
      (
        ((entry.churn90d ?? 0) / churnMax) * 0.4 +
        ((entry.bytes ?? 0) / sizeMax) * 0.2 +
        ((entry.fanIn ?? 0) / fanInMax) * 0.25 +
        (touches / maxTouch) * 0.15
      ).toFixed(6),
    );
  }
  map.heatmap.sort(
    (a, b) => b.heat - a.heat || b.fanIn - a.fanIn || b.churn90d - a.churn90d || a.path.localeCompare(b.path),
  );

  memory.set(key, map);
  await scanner.publish(userId, repoRoot, map).catch(() => undefined);
}

/** Rebuild the map when the repository's HEAD moved since the last build. */
export async function maybeRefreshCodebaseMapOnGitChange(
  userId: string,
  scanner: CodebaseScanner,
  repoRoot: string,
): Promise<void> {
  const cached = memory.get(repoKey(userId, repoRoot));
  if (!cached) return;
  const head = await scanner.head(userId, repoRoot).catch(() => undefined);
  if (!head || !cached.gitHead || head === cached.gitHead) return;
  await ensureCodebaseMap(userId, scanner, { repoRoot, force: true });
}

/** The repositories this account can pick from its workspace. */
export async function listCodebaseRepos(
  userId: string,
  scanner: CodebaseScanner,
): Promise<CodebaseRepoOption[]> {
  const repos = await scanner.listRepos(userId).catch(() => [] as CodebaseRepoOption[]);
  return repos;
}

/**
 * The repository the account picked (the one whose map is injected into its
 * runs), or null when it never picked one.
 */
export async function selectedCodebaseRepo(
  userId: string,
  scanner: CodebaseScanner,
): Promise<string | null> {
  const repoRoot = await scanner.selectedRepo(userId).catch(() => null);
  return repoRoot && repoRoot.trim() ? repoRoot.trim() : null;
}

/** Remember the repository the account picked. */
export async function selectCodebaseRepo(
  userId: string,
  scanner: CodebaseScanner,
  repoRoot: string,
): Promise<void> {
  await scanner.selectRepo(userId, repoRoot).catch(() => undefined);
}

/**
 * Normalize a path the agent touched into a path relative to the repository.
 * Absolute paths are made relative to the repository root when they are
 * inside it, and to the workspace root otherwise; anything outside the
 * workspace is refused.
 */
export function normalizeRepoPath(raw: string, repoRoot?: string): string | null {
  let value = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!value) return null;
  value = value.replace(/^file:\/\//, "");
  const root = repoRoot ? repoRoot.replace(/\/+$/, "") : "";
  if (root && value.startsWith(`${root}/`)) return value.slice(root.length + 1);
  if (value.startsWith("/workspace/")) return value.slice("/workspace/".length);
  if (value.startsWith("./")) value = value.slice(2);
  if (!value || value.startsWith("/") || value.includes("..")) return null;
  return value;
}
