import fs from "node:fs";
import path from "node:path";
import { resolveStorageDir } from "../board/store";
import type { TaskDifficulty } from "../mcp-types";
import type { GardenerFile, GardenerProposal, GardenerUserState } from "./types";

const DEFAULT_MAX_DIFFICULTY: TaskDifficulty = "medium";
export const MAX_TERMINAL_PROPOSALS = 100;

export function pruneTerminalProposals(
  proposals: GardenerProposal[],
  maxTerminal: number = MAX_TERMINAL_PROPOSALS,
): GardenerProposal[] {
  const terminalIndices: Array<{ idx: number; createdAt: number }> = [];
  for (let i = 0; i < proposals.length; i += 1) {
    const status = proposals[i].status;
    if (status === "approved" || status === "dismissed") {
      terminalIndices.push({ idx: i, createdAt: proposals[i].createdAt });
    }
  }
  if (terminalIndices.length <= maxTerminal) return proposals;
  // Drop oldest terminal proposals first (lowest createdAt, then earliest index).
  terminalIndices.sort((a, b) => a.createdAt - b.createdAt || a.idx - b.idx);
  const dropCount = terminalIndices.length - maxTerminal;
  const dropped = new Set<number>();
  for (let i = 0; i < dropCount; i += 1) {
    dropped.add(terminalIndices[i].idx);
  }
  return proposals.filter((_p, i) => !dropped.has(i));
}

let dirOverride: string | null = null;

export function configureGardenerDir(dir: string | null): void {
  dirOverride = dir;
}

function filePath(): string {
  const dir = dirOverride ?? resolveStorageDir();
  return path.join(dir, "gardener.json");
}

function emptyUser(): GardenerUserState {
  return { enabled: false, maxDifficulty: DEFAULT_MAX_DIFFICULTY, pinned: [], proposals: [] };
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
    // Keep the bad bytes: the next save would overwrite gardener.json with the
    // empty fallback and silently destroy every user's proposals and pins.
    let backup = "";
    try {
      backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
    } catch {
      backup = "";
    }
    console.error(
      `[swarm-gardener] gardener file is corrupt (${file})${backup ? `; backed up to ${backup}` : ""}:`,
      err instanceof Error ? err.message : err,
    );
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
  state.proposals = pruneTerminalProposals(state.proposals);
  state.maxDifficulty = normalizeGardenerDifficulty(state);
  data.users[userId] = state;
  saveGardener(data);
  return state;
}

/**
 * Normalize a stored gardener state, including rows written before the Elo
 * removal: a legacy `workerElo` maps onto a max difficulty (<=1200 easy,
 * <=1400 medium, above that hard), and legacy trivial/expert difficulties
 * map onto easy/hard.
 */
export function normalizeGardenerDifficulty(
  state: GardenerUserState & { workerElo?: unknown },
): TaskDifficulty {
  const raw = (state as { maxDifficulty?: unknown }).maxDifficulty;
  if (raw === "easy" || raw === "medium" || raw === "hard") return raw;
  if (raw === "trivial") return "easy";
  if (raw === "expert") return "hard";
  const elo = (state as { workerElo?: unknown }).workerElo;
  if (typeof elo === "number" && Number.isFinite(elo)) {
    return elo <= 1200 ? "easy" : elo <= 1400 ? "medium" : "hard";
  }
  return DEFAULT_MAX_DIFFICULTY;
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
