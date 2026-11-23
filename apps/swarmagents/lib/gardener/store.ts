import fs from "node:fs";
import path from "node:path";
import { resolveStorageDir } from "../board/store";
import type { GardenerFile, GardenerProposal, GardenerUserState } from "./types";

const DEFAULT_ELO = 1400;

let dirOverride: string | null = null;

export function configureGardenerDir(dir: string | null): void {
  dirOverride = dir;
}

function filePath(): string {
  const dir = dirOverride ?? resolveStorageDir();
  return path.join(dir, "gardener.json");
}

function emptyUser(): GardenerUserState {
  return { enabled: false, workerElo: DEFAULT_ELO, pinned: [], proposals: [] };
}

function emptyFile(): GardenerFile {
  return { version: 1, users: {} };
}

export function loadGardener(): GardenerFile {
  const file = filePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyFile();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as GardenerFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.users !== "object" || parsed.users === null) {
      return emptyFile();
    }
    return parsed;
  } catch (err) {
    // A truncated or hand-edited gardener.json must not break every gardener
    // API call and tick for all users until manually deleted. Match the
    // ambient/computers stores: fall back to empty state and log corruption.
    console.error(`[swarm-gardener] gardener file is corrupt (${file}):`, err instanceof Error ? err.message : err);
    return emptyFile();
  }
}

export function saveGardener(data: GardenerFile): void {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readUserGardener(userId: string): GardenerUserState {
  return loadGardener().users[userId] ?? emptyUser();
}

export function updateUserGardener(
  userId: string,
  mutate: (state: GardenerUserState) => void,
): GardenerUserState {
  const data = loadGardener();
  const state = data.users[userId] ?? emptyUser();
  mutate(state);
  state.workerElo = clampElo(state.workerElo);
  data.users[userId] = state;
  saveGardener(data);
  return state;
}

export function clampElo(elo: number): number {
  if (!Number.isFinite(elo)) return DEFAULT_ELO;
  return Math.max(1000, Math.min(1800, Math.round(elo)));
}

/**
 * Drop a pinned repository and every proposal scoped to it. Proposals are
 * queued work for that repoRoot, so leaving them behind after an unpin would
 * leave cards a user can approve with nowhere to run. Returns true when
 * anything was actually removed.
 */
export function unpinRepo(userId: string, repoRoot: string): boolean {
  let changed = false;
  updateUserGardener(userId, (state) => {
    const pinnedBefore = state.pinned.length;
    state.pinned = state.pinned.filter((row) => row.repoRoot !== repoRoot);
    if (state.pinned.length !== pinnedBefore) changed = true;
    const proposalsBefore = state.proposals.length;
    state.proposals = state.proposals.filter((row) => row.repoRoot !== repoRoot);
    if (state.proposals.length !== proposalsBefore) changed = true;
  });
  return changed;
}

/**
 * Remove one proposal outright. `setProposalStatus` only records a verdict and
 * keeps the row so history survives; this is the "get it off my screen" verb.
 */
export function removeProposal(userId: string, proposalId: string): boolean {
  let removed = false;
  updateUserGardener(userId, (state) => {
    const before = state.proposals.length;
    state.proposals = state.proposals.filter((row) => row.id !== proposalId);
    if (state.proposals.length !== before) removed = true;
  });
  return removed;
}

export function setProposalStatus(
  userId: string,
  proposalId: string,
  status: GardenerProposal["status"],
): GardenerProposal | null {
  let found: GardenerProposal | null = null;
  updateUserGardener(userId, (state) => {
    const row = state.proposals.find((p) => p.id === proposalId);
    if (!row) return;
    row.status = status;
    found = row;
  });
  return found;
}
