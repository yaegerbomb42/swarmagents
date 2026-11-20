/**
 * Per-account project store for project continuity (g5).
 *
 * A project groups the threads (harness sessions) that work on one repo or
 * workspace, and carries the state needed to resume after a gap: open files,
 * the last commands with their exit codes, the last test results, pinned
 * notes, and the active branch. Everything lives in the owner's own account
 * directory — `<data dir>/users/<hash(userId)>/projects.json` (dir 700, file
 * 600) — the same per-user layout the provider/role stores use. There is no
 * server-wide project file, so one account can never read another's state.
 *
 * Reads are normalised and capped: a malformed or foreign file is ignored
 * (never crashes a route), and every list is bounded so a runaway agent
 * cannot grow the store without limit.
 */

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, userDirName, type DataDirOptions } from "../providers/store";
import { atomicWriteFile } from "../atomic-write";
import { isComputeTarget } from "../computers/compute";

export const PROJECTS_SCHEMA = "swarm-projects";
export const PROJECTS_VERSION = 1;
export const MAX_PROJECTS = 100;
export const MAX_COMMANDS = 20;
export const MAX_OPEN_FILES = 50;
export const MAX_PINNED_NOTES = 20;
export const MAX_THREADS = 200;
export const MAX_NAME_LEN = 80;
export const MAX_REPO_LEN = 200;
export const MAX_PATH_LEN = 300;
export const MAX_BRANCH_LEN = 200;
export const MAX_NOTE_LEN = 500;
export const MAX_COMMAND_LEN = 500;
export const MAX_FILE_LEN = 300;
export const MAX_THREAD_ID_LEN = 256;
export const SHARE_TOKEN_BYTES = 24;
export const SHARE_INDEX_SCHEMA = "swarm-share-index";
export const SHARE_INDEX_VERSION = 1;
/** Directory (under the data dir) holding one index file per share token. */
export const SHARE_INDEX_DIR = "shares";
/** Marker file written once the legacy scan has run for a data dir. */
export const SHARE_INDEX_MARKER = ".index-built";

const PROJECT_ID_RE = /^prj_[a-f0-9-]{8,64}$/i;
const SHARE_TOKEN_RE = /^[a-f0-9]{48}$/;

export interface ProjectCommand {
  command: string;
  /** Process exit code. Derived from the tool result when the harness does not
      report one (ok -> 0, failed -> 1) and refined from `Exit code N` lines. */
  exitCode: number;
  at: number;
  /** Run that recorded the command, for traceability. */
  runId?: string;
}

export interface ProjectTestResult {
  command: string;
  ok: boolean;
  exitCode: number;
  passed?: number;
  failed?: number;
  /** Up to three failing test names/lines, for the Resume card. */
  failing: string[];
  /** Tail of the test output (bounded), useful context for the next thread. */
  outputTail?: string;
  at: number;
  runId?: string;
}

export interface ProjectShare {
  token: string;
  createdAt: number;
  revokedAt?: number;
}

export interface Project {
  id: string;
  /** Owner. Kept in the record so a copied/foreign file is detected. */
  userId: string;
  name: string;
  repo?: string;
  workspacePath: string;
  activeBranch?: string;
  openFiles: string[];
  commands: ProjectCommand[];
  lastTest: ProjectTestResult | null;
  pinnedNotes: string[];
  /** Thread ids (harness sessionIds, or runIds for sessionless runs). */
  threads: string[];
  /** Remembered compute target for this project: "cloud" or "computer:<id>". */
  computeTarget?: string;
  createdAt: number;
  updatedAt: number;
  share: ProjectShare | null;
}

/** The read-only shape a share link is allowed to reveal. */
export interface SharedProjectView {
  id: string;
  name: string;
  repo?: string;
  activeBranch?: string;
  openFiles: string[];
  commands: ProjectCommand[];
  lastTest: ProjectTestResult | null;
  pinnedNotes: string[];
  threadCount: number;
  updatedAt: number;
  sharedAt: number;
}

/**
 * One share token index entry: the token points straight at the owner and
 * the project, so resolving a link never has to look at another account.
 */
export interface ShareIndexEntry {
  schema: typeof SHARE_INDEX_SCHEMA;
  version: typeof SHARE_INDEX_VERSION;
  token: string;
  ownerId: string;
  projectId: string;
  createdAt: number;
}

interface ProjectsFile {
  schema: typeof PROJECTS_SCHEMA;
  version: typeof PROJECTS_VERSION;
  userId: string;
  projects: Project[];
}

let OVERRIDE_DIR: string | undefined;

/** Test hook: point the store at a directory ("" resets to the data dir). */
export function configureProjectStoreDir(dir: string): void {
  OVERRIDE_DIR = dir || undefined;
}

function dataDir(options: DataDirOptions = {}): string {
  return OVERRIDE_DIR ?? resolveDataDir(options);
}

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 256) {
    throw new ProjectError("A signed-in user is required.", 401);
  }
  return userId;
}

/** One user's projects file. */
export function userProjectsFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(dataDir(options), "users", userDirName(userId), "projects.json");
}

export class ProjectError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProjectError";
    this.status = status;
  }
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = num(value);
  if (n === undefined) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cleanFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const file = str(raw, MAX_FILE_LEN);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
    if (out.length >= MAX_OPEN_FILES) break;
  }
  return out;
}

function cleanCommands(value: unknown): ProjectCommand[] {
  if (!Array.isArray(value)) return [];
  const out: ProjectCommand[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const command = str(record.command, MAX_COMMAND_LEN);
    if (!command) continue;
    const exitCode = clampInt(record.exitCode, -1, 255) ?? 1;
    const at = num(record.at) ?? 0;
    const runId = str(record.runId, 128);
    out.push({ command, exitCode, at, ...(runId ? { runId } : {}) });
  }
  // Newest last, as rendered; keep only the last MAX_COMMANDS.
  return out.sort((a, b) => a.at - b.at).slice(-MAX_COMMANDS);
}

function cleanNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const note = str(raw, MAX_NOTE_LEN);
    if (!note) continue;
    out.push(note);
    if (out.length >= MAX_PINNED_NOTES) break;
  }
  return out;
}

function cleanThreads(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = str(raw, MAX_THREAD_ID_LEN);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_THREADS) break;
  }
  return out;
}

function cleanTest(value: unknown): ProjectTestResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const command = str(record.command, MAX_COMMAND_LEN);
  if (!command) return null;
  const failing = Array.isArray(record.failing)
    ? record.failing
        .map((item) => str(item, 300))
        .filter((item): item is string => Boolean(item))
        .slice(0, 3)
    : [];
  return {
    command,
    ok: record.ok === true,
    exitCode: clampInt(record.exitCode, -1, 255) ?? 1,
    ...(clampInt(record.passed, 0, 1_000_000) !== undefined
      ? { passed: clampInt(record.passed, 0, 1_000_000) }
      : {}),
    ...(clampInt(record.failed, 0, 1_000_000) !== undefined
      ? { failed: clampInt(record.failed, 0, 1_000_000) }
      : {}),
    failing,
    ...(typeof record.outputTail === "string" ? { outputTail: record.outputTail.slice(0, 1000) } : {}),
    at: num(record.at) ?? 0,
    ...(str(record.runId, 128) ? { runId: str(record.runId, 128) } : {}),
  };
}

function cleanShare(value: unknown): ProjectShare | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const token = typeof record.token === "string" ? record.token : "";
  if (!SHARE_TOKEN_RE.test(token)) return null;
  return {
    token,
    createdAt: num(record.createdAt) ?? 0,
    ...(num(record.revokedAt) !== undefined ? { revokedAt: num(record.revokedAt) } : {}),
  };
}

function normalizeProject(raw: unknown, userId: string): Project | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!PROJECT_ID_RE.test(id)) return null;
  // Owner check: a file from another account (or a hand-edited copy) is ignored.
  if (record.userId !== userId) return null;
  const name = str(record.name, MAX_NAME_LEN);
  if (!name) return null;
  const createdAt = num(record.createdAt) ?? 0;
  const updatedAt = num(record.updatedAt) ?? createdAt;
  return {
    id,
    userId,
    name,
    ...(str(record.repo, MAX_REPO_LEN) ? { repo: str(record.repo, MAX_REPO_LEN) } : {}),
    workspacePath: str(record.workspacePath, MAX_PATH_LEN) ?? "/workspace",
    ...(str(record.activeBranch, MAX_BRANCH_LEN)
      ? { activeBranch: str(record.activeBranch, MAX_BRANCH_LEN) }
      : {}),
    openFiles: cleanFiles(record.openFiles),
    commands: cleanCommands(record.commands),
    lastTest: cleanTest(record.lastTest),
    pinnedNotes: cleanNotes(record.pinnedNotes),
    threads: cleanThreads(record.threads),
    ...(isComputeTarget(record.computeTarget) ? { computeTarget: (record.computeTarget as string).trim() } : {}),
    createdAt,
    updatedAt,
    share: cleanShare(record.share),
  };
}

function emptyFile(userId: string): ProjectsFile {
  return { schema: PROJECTS_SCHEMA, version: PROJECTS_VERSION, userId, projects: [] };
}

function readFileFor(userId: string, options: DataDirOptions = {}): ProjectsFile {
  requireUserId(userId);
  const file = userProjectsFilePath(userId, options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile(userId);
    const record = parsed as Record<string, unknown>;
    if (record.userId !== userId) {
      console.error(`[swarm-projects] ignoring projects file ${file}: owner mismatch.`);
      return emptyFile(userId);
    }
    const projects = Array.isArray(record.projects)
      ? record.projects
          .map((entry) => normalizeProject(entry, userId))
          .filter((entry): entry is Project => entry !== null)
          .slice(0, MAX_PROJECTS)
      : [];
    return { schema: PROJECTS_SCHEMA, version: PROJECTS_VERSION, userId, projects };
  } catch {
    // Missing or corrupt file: treat as empty, never crash a route.
    return emptyFile(userId);
  }
}

function writeFileFor(userId: string, data: ProjectsFile, options: DataDirOptions = {}): void {
  const file = userProjectsFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on read-only or foreign-owned mounts.
  }
  atomicWriteFile(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

function byUpdatedDesc(a: Project, b: Project): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
}

/** All projects for one account, newest activity first. */
export function listProjects(userId: string, options: DataDirOptions = {}): Project[] {
  return readFileFor(userId, options).projects.sort(byUpdatedDesc);
}

/** One project owned by the account, or null. */
export function getProject(userId: string, projectId: string, options: DataDirOptions = {}): Project | null {
  if (!PROJECT_ID_RE.test(projectId)) return null;
  return readFileFor(userId, options).projects.find((project) => project.id === projectId) ?? null;
}

export function createProject(
  userId: string,
  input: { name?: unknown; repo?: unknown; workspacePath?: unknown; activeBranch?: unknown; computeTarget?: unknown },
  options: DataDirOptions = {},
): Project {
  requireUserId(userId);
  const name = str(input.name, MAX_NAME_LEN);
  if (!name) throw new ProjectError("Project name is required.", 400);
  const data = readFileFor(userId, options);
  if (data.projects.length >= MAX_PROJECTS) {
    throw new ProjectError(`Project limit reached (${MAX_PROJECTS}).`, 409);
  }
  const now = Date.now();
  const project: Project = {
    id: `prj_${randomUUID()}`,
    userId,
    name,
    ...(str(input.repo, MAX_REPO_LEN) ? { repo: str(input.repo, MAX_REPO_LEN) } : {}),
    workspacePath: str(input.workspacePath, MAX_PATH_LEN) ?? "/workspace",
    ...(str(input.activeBranch, MAX_BRANCH_LEN)
      ? { activeBranch: str(input.activeBranch, MAX_BRANCH_LEN) }
      : {}),
    openFiles: [],
    commands: [],
    lastTest: null,
    pinnedNotes: [],
    threads: [],
    ...(isComputeTarget(input.computeTarget) ? { computeTarget: (input.computeTarget as string).trim() } : {}),
    createdAt: now,
    updatedAt: now,
    share: null,
  };
  data.projects.push(project);
  writeFileFor(userId, data, options);
  return project;
}

export interface ProjectPatch {
  name?: unknown;
  repo?: unknown;
  workspacePath?: unknown;
  activeBranch?: unknown;
  openFiles?: unknown;
  pinnedNotes?: unknown;
  computeTarget?: unknown;
}

/** Update the user-editable project fields. Returns the updated project. */
export function updateProject(
  userId: string,
  projectId: string,
  patch: ProjectPatch,
  options: DataDirOptions = {},
): Project {
  const project = mutateProject(
    userId,
    projectId,
    (current) => {
      if (patch.name !== undefined) {
        const name = str(patch.name, MAX_NAME_LEN);
        if (!name) throw new ProjectError("Project name is required.", 400);
        current.name = name;
      }
      if (patch.repo !== undefined) {
        const repo = str(patch.repo, MAX_REPO_LEN);
        if (repo) current.repo = repo;
        else delete current.repo;
      }
      if (patch.workspacePath !== undefined) {
        const workspacePath = str(patch.workspacePath, MAX_PATH_LEN);
        if (!workspacePath) throw new ProjectError("Workspace path is required.", 400);
        current.workspacePath = workspacePath;
      }
      if (patch.activeBranch !== undefined) {
        const branch = str(patch.activeBranch, MAX_BRANCH_LEN);
        if (branch) current.activeBranch = branch;
        else delete current.activeBranch;
      }
      if (patch.openFiles !== undefined) current.openFiles = cleanFiles(patch.openFiles);
      if (patch.pinnedNotes !== undefined) current.pinnedNotes = cleanNotes(patch.pinnedNotes);
      if (patch.computeTarget !== undefined) {
        if (patch.computeTarget === null || patch.computeTarget === "") {
          delete current.computeTarget;
        } else if (isComputeTarget(patch.computeTarget)) {
          current.computeTarget = (patch.computeTarget as string).trim();
        } else {
          throw new ProjectError("Unknown compute target.", 400);
        }
      }
    },
    options,
  );
  return project;
}

export function deleteProject(userId: string, projectId: string, options: DataDirOptions = {}): boolean {
  const data = readFileFor(userId, options);
  const before = data.projects.length;
  const removed = data.projects.filter((project) => project.id === projectId);
  data.projects = data.projects.filter((project) => project.id !== projectId);
  if (data.projects.length === before) return false;
  writeFileFor(userId, data, options);
  // A deleted project must not stay reachable through its share link.
  for (const project of removed) {
    if (project.share) removeShareIndexEntry(project.share.token, options);
  }
  return true;
}

/**
 * Read-modify-write one project atomically within the process. Throws 404 when
 * the project does not exist (or belongs to another account).
 */
export function mutateProject(
  userId: string,
  projectId: string,
  mutate: (project: Project) => void,
  options: DataDirOptions = {},
): Project {
  const data = readFileFor(userId, options);
  const project = data.projects.find((entry) => entry.id === projectId);
  if (!project) throw new ProjectError("Project not found.", 404);
  mutate(project);
  project.updatedAt = Date.now();
  writeFileFor(userId, data, options);
  return project;
}

/** Add a thread id to a project once. Bounded, no duplicates. */
export function attachThread(userId: string, projectId: string, threadId: string): void {
  const id = str(threadId, MAX_THREAD_ID_LEN);
  if (!id) return;
  try {
    mutateProject(userId, projectId, (project) => {
      if (project.threads.includes(id)) return;
      project.threads.push(id);
      if (project.threads.length > MAX_THREADS) {
        project.threads.splice(0, project.threads.length - MAX_THREADS);
      }
    });
  } catch {
    // A project deleted mid-run must not break telemetry handling.
  }
}

/** Create or rotate a project's share token. */
export function createShareLink(userId: string, projectId: string, options: DataDirOptions = {}): ProjectShare {
  // One-time legacy migration (see ensureShareIndex) before the first write,
  // so a share created after the upgrade never hides an older share.
  ensureShareIndex(options);
  const previous = getProject(userId, projectId, options)?.share?.token;
  const token = randomBytes(SHARE_TOKEN_BYTES).toString("hex");
  const project = mutateProject(
    userId,
    projectId,
    (current) => {
      current.share = { token, createdAt: Date.now() };
    },
    options,
  );
  const share = project.share as ProjectShare;
  // Rotating replaces the token: the old index entry must not survive it.
  if (previous && previous !== token) removeShareIndexEntry(previous, options);
  writeShareIndexEntry(
    {
      schema: SHARE_INDEX_SCHEMA,
      version: SHARE_INDEX_VERSION,
      token,
      ownerId: userId,
      projectId,
      createdAt: share.createdAt,
    },
    options,
  );
  return share;
}

/** Revoke the share link; the token stops resolving immediately. */
export function revokeShareLink(userId: string, projectId: string, options: DataDirOptions = {}): boolean {
  const project = getProject(userId, projectId, options);
  if (!project?.share) return false;
  const token = project.share.token;
  mutateProject(
    userId,
    projectId,
    (current) => {
      if (current.share) current.share.revokedAt = Date.now();
    },
    options,
  );
  // A revoked token must not resolve any more, index or not.
  removeShareIndexEntry(token, options);
  return true;
}

/** Strip credentials from text that leaves the owner's account (share view). */
export function redactForShare(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{12,}/g, "[redacted]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*[^\s'"]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(--?(?:api[-_]?key|token|password|secret)\s+)(\S+)/gi, "$1[redacted]");
}

/** Strip the owner and everything not safe to show on a public share page. */
export function toSharedView(project: Project, sharedAt: number): SharedProjectView {
  return {
    id: project.id,
    name: project.name,
    ...(project.repo ? { repo: project.repo } : {}),
    ...(project.activeBranch ? { activeBranch: project.activeBranch } : {}),
    openFiles: [...project.openFiles],
    // Public pages get a shorter history; it is a snapshot, not an archive.
    commands: project.commands.slice(-10).map((entry) => ({
      ...entry,
      command: redactForShare(entry.command),
    })),
    lastTest: project.lastTest
      ? {
          ...project.lastTest,
          command: redactForShare(project.lastTest.command),
          failing: project.lastTest.failing.map(redactForShare),
          ...(project.lastTest.outputTail
            ? { outputTail: redactForShare(project.lastTest.outputTail) }
            : {}),
        }
      : null,
    pinnedNotes: project.pinnedNotes.map(redactForShare),
    threadCount: project.threads.length,
    updatedAt: project.updatedAt,
    sharedAt,
  };
}

function projectDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, "users"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, "users", entry.name));
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- *
 * Share token index (b18 / bug 19)
 *
 * The public share page used to scan every account's projects.json for the
 * token. A miss cost exactly as much as a hit, so an unauthenticated
 * (and, until now, unthrottled) URL space let a scanner turn one request
 * into a full parse of every account on the box.
 *
 * The index removes that: one file per token, `<data dir>/shares/<token>.json`
 * -> { ownerId, projectId }. A lookup is one read of that file plus one read
 * of the *owner's* project file — never another account's — so the cost is
 * the same whether the box hosts one account or two thousand.
 * -------------------------------------------------------------------------- */

/** Directory holding the share token index. */
export function shareIndexDir(options: DataDirOptions = {}): string {
  return path.join(dataDir(options), SHARE_INDEX_DIR);
}

/** The index file for one token. */
export function shareIndexEntryPath(token: string, options: DataDirOptions = {}): string {
  return path.join(shareIndexDir(options), `${token}.json`);
}

/** Marker file: written once the legacy scan has run for this data dir. */
export function shareIndexMarkerPath(options: DataDirOptions = {}): string {
  return path.join(shareIndexDir(options), SHARE_INDEX_MARKER);
}

function cleanShareIndexEntry(value: unknown, token: string): ShareIndexEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== SHARE_INDEX_SCHEMA) return null;
  if (record.version !== SHARE_INDEX_VERSION) return null;
  if (record.token !== token) return null;
  const ownerId = typeof record.ownerId === "string" ? record.ownerId : "";
  if (!ownerId || ownerId.length > 256) return null;
  const projectId = typeof record.projectId === "string" ? record.projectId : "";
  if (!PROJECT_ID_RE.test(projectId)) return null;
  return {
    schema: SHARE_INDEX_SCHEMA,
    version: SHARE_INDEX_VERSION,
    token,
    ownerId,
    projectId,
    createdAt: num(record.createdAt) ?? 0,
  };
}

/** Read one index entry. A missing or malformed file is simply "no entry". */
export function readShareIndexEntry(token: string, options: DataDirOptions = {}): ShareIndexEntry | null {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(shareIndexEntryPath(token, options), "utf-8")) as unknown;
    return cleanShareIndexEntry(parsed, token);
  } catch {
    return null;
  }
}

/** Write one index entry atomically (temp file + rename). */
export function writeShareIndexEntry(entry: ShareIndexEntry, options: DataDirOptions = {}): void {
  const dir = shareIndexDir(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on read-only or foreign-owned mounts.
  }
  const file = shareIndexEntryPath(entry.token, options);
  atomicWriteFile(file, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

/** Drop one index entry (revoke, rotate, project delete, stale entry). */
export function removeShareIndexEntry(token: string, options: DataDirOptions = {}): void {
  if (!SHARE_TOKEN_RE.test(token)) return;
  try {
    fs.rmSync(shareIndexEntryPath(token, options), { force: true });
  } catch {
    // Best effort: the entry is re-checked against the project on lookup.
  }
}

/** Data dirs whose legacy scan already ran in this process. */
const migratedRoots = new Set<string>();

/** True when the legacy scan already ran for this data dir (marker on disk). */
export function shareIndexBuilt(options: DataDirOptions = {}): boolean {
  try {
    return fs.existsSync(shareIndexMarkerPath(options));
  } catch {
    return false;
  }
}

/**
 * One-time migration: index every share that already lives in an account's
 * projects.json so links created before the index existed keep resolving.
 *
 * It runs at most once per data dir per process and is also guarded by a
 * marker file on disk, so a restart does not turn every miss into a scan
 * again. Returns the number of live shares that were indexed.
 */
export function ensureShareIndex(options: DataDirOptions = {}): number {
  const root = dataDir(options);
  if (migratedRoots.has(root)) return 0;
  migratedRoots.add(root);
  let indexed = 0;
  try {
    for (const dir of projectDirs(root)) {
      const file = path.join(dir, "projects.json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const owner = typeof record.userId === "string" ? record.userId : "";
      if (!owner || !Array.isArray(record.projects)) continue;
      for (const raw of record.projects) {
        const project = normalizeProject(raw, owner);
        if (!project?.share) continue;
        if (project.share.revokedAt !== undefined) {
          // Revoked links never resolve: make sure no stale entry survives.
          removeShareIndexEntry(project.share.token, options);
          continue;
        }
        try {
          writeShareIndexEntry(
            {
              schema: SHARE_INDEX_SCHEMA,
              version: SHARE_INDEX_VERSION,
              token: project.share.token,
              ownerId: owner,
              projectId: project.id,
              createdAt: project.share.createdAt,
            },
            options,
          );
          indexed += 1;
        } catch {
          // A single unwritable entry must not abort the migration.
        }
      }
    }
  } catch {
    // The scan is best effort: a broken data dir must not break startup.
  }
  try {
    fs.mkdirSync(shareIndexDir(options), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      shareIndexMarkerPath(options),
      `${JSON.stringify({ schema: SHARE_INDEX_SCHEMA, version: SHARE_INDEX_VERSION, builtAt: Date.now() })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // Best effort: without the marker the next process scans again.
  }
  return indexed;
}

/**
 * The project an index entry points at, verified against the owner's own
 * file: the token must still be the project's live token and the share must
 * not be revoked. A stale entry (rotated, revoked, project deleted) is
 * dropped and never resolves.
 */
function projectForShareEntry(entry: ShareIndexEntry, options: DataDirOptions = {}): Project | null {
  let project: Project | undefined;
  try {
    project = readFileFor(entry.ownerId, options).projects.find((entry_) => entry_.id === entry.projectId);
  } catch {
    return null;
  }
  if (!project?.share) return null;
  if (project.share.token !== entry.token) return null;
  if (project.share.revokedAt !== undefined) return null;
  return project;
}

interface ResolvedShare {
  entry: ShareIndexEntry;
  project: Project;
  ownerId: string;
  projectId: string;
}

/**
 * Resolve a live share token to its index entry and verified project. The
 * token is the only credential and the only thing that is read: one index
 * file, then the owner's project file. Revoked tokens never resolve, and a
 * miss never reads another account's file.
 */
function resolveShare(token: string, options: DataDirOptions = {}): ResolvedShare | null {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  let entry = readShareIndexEntry(token, options);
  if (!entry) {
    // No index entry: if the index was never built for this data dir, run the
    // one-time migration and look the token up again.
    if (!shareIndexBuilt(options)) {
      ensureShareIndex(options);
      entry = readShareIndexEntry(token, options);
    }
    if (!entry) return null;
  }
  const project = projectForShareEntry(entry, options);
  if (!project) {
    // The index entry outlived its project: drop it and resolve nothing.
    removeShareIndexEntry(token, options);
    return null;
  }
  return { entry, project, ownerId: entry.ownerId, projectId: entry.projectId };
}

/**
 * Resolve a live share token. The token is the only credential and the only
 * thing that is read: one index file, then the owner's project file. Revoked
 * tokens never resolve, and a miss never reads another account's file.
 */
export function getSharedProject(token: string, options: DataDirOptions = {}): SharedProjectView | null {
  const resolved = resolveShare(token, options);
  if (!resolved) return null;
  return toSharedView(resolved.project, resolved.project.share?.createdAt ?? resolved.entry.createdAt);
}

export interface ShareOwner {
  ownerId: string;
  projectId: string;
}

/**
 * Resolve a live share token to its owner, for gating guest access without
 * ever exposing the owner's identity to the guest. Returns null for a
 * missing/revoked/rotated token or a deleted project.
 */
export function resolveShareOwner(token: string, options: DataDirOptions = {}): ShareOwner | null {
  const resolved = resolveShare(token, options);
  if (!resolved) return null;
  return { ownerId: resolved.ownerId, projectId: resolved.projectId };
}

/** Validate a project id without touching the store (routes use this early). */
export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_RE.test(value);
}
