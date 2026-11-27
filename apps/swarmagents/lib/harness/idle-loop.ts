/**
 * idle-loop.ts — Always-on A1: LLM-proposed creative work loop (24/7, never idle).
 *
 * Today an agent run ends when its task ends and A1 sits idle. This loop
 * keeps A1 working on its own: when the user has no run active, it asks the
 * router-chosen fast model for ONE concrete creative improvement (a UI
 * polish, a piece of content, a small feature, a real fix), grounded in a
 * short repo digest, validates the proposal against an allowlist/denylist,
 * and turns it into a board task for a human or worker to pick up.
 *
 * Propose-only MVP (James's redesign, 2026-11-26): the loop NEVER dispatches
 * an implementation run by default. Dispatch is a follow-up behind its own
 * flag (SWARM_A1_IDLE_LOOP_DISPATCH=1) and goes through the normal approval
 * gateway (fullAuto: false), never fullAuto: true — so irreversible steps
 * still need a human.
 *
 * Safety, by design:
 * - OFF by default. The loop only runs when SWARM_A1_IDLE_LOOP=1 is set
 *   explicitly. There is no implicit enablement in tests or dev.
 * - Kill-switch: setting SWARM_A1_IDLE_LOOP=0 (or calling stop()) stops the
 *   loop within one iteration — the flag is re-checked before any board
 *   task is created and again before any dispatch, so a loop that is
 *   killed mid-iteration never starts new work.
 * - Board pause signal: any open board task whose title contains
 *   "[a1-loop-pause]" pauses the loop until the task is closed.
 * - Denylist: proposals touching billing, deploy, secrets/credentials,
 *   auth, user data, or destructive ops are rejected, never executed.
 *   The denylist is a backstop, not the defence: because the loop only
 *   proposes, a proposal that slips past it still lands as a board task
 *   a human reviews — it is never executed automatically.
 * - Token budget: one bounded LLM call per iteration, capped by
 *   HARD_CAP_TOKENS_PER_ITERATION, on the router's fast tier (never a
 *   hard-coded paid model) with the user's preferFreeProviders respected.
 * - Daily cap: at most SWARM_A1_IDLE_LOOP_DAILY_CAP (default 2) loop
 *   outputs per user per day, persisted to disk so a restart does not
 *   reset it. A failed or refused dispatch latches the loop off for the
 *   rest of the day instead of retrying every 5 minutes.
 * - Concurrency: one loop object per user at module level, so the
 *   "never two iterations concurrently" guard is real across ticks.
 * - Idleness is scoped to the user's own runs (active exec, active or
 *   queued run) — never to the shared board, which always has open tasks.
 *   A dispatched run claims the task it was created for.
 * - Per-user scoping: loop-created tasks carry a per-user marker, and
 *   the loop dedupes against its own user's open proposals, so two
 *   always-on users never duplicate each other's proposals.
 * - No real LLM calls in tests: the LLM call is an injected dependency.
 *
 * The engine is dependency-injected (same pattern as lib/runtime/schedules):
 * unit tests run it with fakes, and production deps live in
 * productionIdleLoopDeps(). The background ticker is started from
 * instrumentation.ts next to startScheduleTicks().
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { handleCreateTask } from "../board/handlers";
import { getStoragePaths, loadStore } from "../board/store";
import { forwardLlmNonStreaming } from "../runtime/llm-gateway";
import { getRuntimeManager } from "../runtime/manager";
import { parseAlwaysOnUsers } from "../vm/idle";

/** Env flag for the kill-switch. The loop only runs when this is exactly "1". */
export const A1_IDLE_LOOP_ENV = "SWARM_A1_IDLE_LOOP";

/** Second flag: only when this is exactly "1" may the loop dispatch an implementation run. Default: propose-only. */
export const A1_IDLE_LOOP_DISPATCH_ENV = "SWARM_A1_IDLE_LOOP_DISPATCH";

/** Env flag for the hard daily cap (loop outputs per user per day). */
export const A1_IDLE_LOOP_DAILY_CAP_ENV = "SWARM_A1_IDLE_LOOP_DAILY_CAP";

/** Open board task title marker that pauses the loop until the task closes. */
export const A1_IDLE_LOOP_PAUSE_MARKER = "[a1-loop-pause]";

/** Default token budget for the single proposal LLM call per iteration. */
export const DEFAULT_MAX_TOKENS_PER_ITERATION = 2000;
/** Hard cap: no iteration may ask the LLM for more than this. */
export const HARD_CAP_TOKENS_PER_ITERATION = 4000;

/** Default hard daily cap: at most this many loop outputs per user per day. */
export const DEFAULT_DAILY_CAP = 2;
/** Upper bound for the daily cap env override (a larger value is clamped). */
export const MAX_DAILY_CAP = 10;

/** Router tier for the proposal call: cheap and fast; the router picks the provider (respecting preferFreeProviders). */
export const IDLE_LOOP_MODEL_TIER = "fast" as const;

/** Persisted daily-budget file, under the storage dir (same pattern as handoffs.json). */
export const IDLE_LOOP_BUDGET_FILENAME = "idle-loop-budget.json";

/** Repo digest bounds: at most this many items per section, this many chars total. */
export const MAX_DIGEST_ITEMS = 10;
export const MAX_DIGEST_CHARS = 4000;

/** How often the background ticker checks for idle time (5 minutes). */
export const DEFAULT_IDLE_LOOP_INTERVAL_MS = 5 * 60 * 1000;

export type CreativeArea = "ui" | "content" | "tests" | "feature" | "fix";

export const ALLOWED_AREAS: readonly CreativeArea[] = [
  "ui",
  "content",
  "tests",
  "feature",
  "fix",
];

export interface CreativeProposal {
  title: string;
  description: string;
  area: CreativeArea;
  files?: string[];
}

export interface RepoDigestInput {
  openTasks?: Array<{ id: string; title: string }>;
  recentCommits?: string[];
  knownGaps?: string[];
}

/**
 * Forbidden topics for autonomous proposals. Matched case-insensitively
 * against the proposal's title + description + files, on word boundaries
 * where a bare substring would false-positive (e.g. "author" must not trip
 * "auth"). The loop is conservative on purpose: a rejected proposal is
 * logged and skipped, and a human can always do it instead.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bbilling\b/i,
  /\bpayment\b/i,
  /\binvoice\b/i,
  /\bsubscription\b/i,
  /\bdeploy\b/i,
  /\brelease\b/i,
  /\bsecret\b/i,
  /\bcredential\b/i,
  /\bpassword\b/i,
  /\bprivate key\b/i,
  /\bapi key\b/i,
  /\bauth\b/i,
  /\boauth\b/i,
  /\blogin\b/i,
  /\bsso\b/i,
  /\bsession\b/i,
  /\bpermission\b/i,
  /\buser data\b/i,
  /\bpersonal data\b/i,
  /\bpii\b/i,
  /\bdelete\b/i,
  /\bdestroy\b/i,
  /\bdrop table\b/i,
  /\brm -rf\b/i,
  /\bwipe\b/i,
];

const MAX_PROPOSAL_TITLE_LEN = 200;
const MAX_PROPOSAL_DESCRIPTION_LEN = 2000;

/** The loop only runs when the flag is explicitly "1". Default: off. */
export function isIdleLoopEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[A1_IDLE_LOOP_ENV] === "1";
}

/** An open board task titled with the pause marker pauses the loop. */
export function isIdleLoopPaused(
  openTasks: Array<{ title: string }>,
): boolean {
  return openTasks.some((task) => task.title.includes(A1_IDLE_LOOP_PAUSE_MARKER));
}

/** Dispatch is opt-in behind a second flag. Default: propose-only. */
export function isDispatchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[A1_IDLE_LOOP_DISPATCH_ENV] === "1";
}

/** Clamp the daily-cap env override to 0..MAX_DAILY_CAP (default 2). */
export function resolveDailyCap(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env[A1_IDLE_LOOP_DAILY_CAP_ENV]);
  if (!Number.isFinite(raw)) return DEFAULT_DAILY_CAP;
  return Math.max(0, Math.min(Math.floor(raw), MAX_DAILY_CAP));
}

/**
 * Per-user marker stamped into every loop-created board task description.
 * The board is global, so the marker is how one user's loop recognises its
 * own proposals (for dedupe) without touching another user's.
 */
export function idleLoopUserMarker(userId: string): string {
  return `[a1-loop user:${userId}]`;
}

/** One day of loop budget for one user. `failed` latches the loop off for the rest of the day. */
export interface IdleLoopBudgetState {
  date: string;
  actions: number;
  failed: boolean;
}

export interface IdleLoopBudgetStore {
  load(userId: string): IdleLoopBudgetState;
  recordAction(userId: string): void;
  recordFailure(userId: string): void;
}

function utcToday(today?: () => string): string {
  return today ? today() : new Date().toISOString().slice(0, 10);
}

function freshBudgetState(date: string): IdleLoopBudgetState {
  return { date, actions: 0, failed: false };
}

function isBudgetState(value: unknown): value is IdleLoopBudgetState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<IdleLoopBudgetState>;
  return (
    typeof v.date === "string" &&
    typeof v.actions === "number" &&
    typeof v.failed === "boolean"
  );
}

/** In-memory budget store (tests, and any caller that does not need persistence). */
export function createMemoryBudgetStore(
  today?: () => string,
): IdleLoopBudgetStore {
  const states = new Map<string, IdleLoopBudgetState>();
  const current = (userId: string): IdleLoopBudgetState => {
    const date = utcToday(today);
    const stored = states.get(userId);
    if (stored && stored.date === date) return stored;
    const fresh = freshBudgetState(date);
    states.set(userId, fresh);
    return fresh;
  };
  return {
    load(userId) {
      return { ...current(userId) };
    },
    recordAction(userId) {
      current(userId).actions += 1;
    },
    recordFailure(userId) {
      current(userId).failed = true;
    },
  };
}

function defaultBudgetFilePath(): string {
  return path.join(getStoragePaths().STORAGE_DIR, IDLE_LOOP_BUDGET_FILENAME);
}

/**
 * File-backed budget store: the daily cap survives a restart because the
 * count lives on disk, not in process memory. Reads are fresh on every
 * load (so two loops sharing the file see each other's writes); writes
 * are synchronous read-modify-write, so they cannot interleave.
 * A missing or corrupt file behaves as an empty store.
 */
export function createFileBudgetStore(options: {
  filePath?: string;
  today?: () => string;
} = {}): IdleLoopBudgetStore {
  const filePath = options.filePath ?? defaultBudgetFilePath();
  const todayFn = options.today;
  const readAll = (): Record<string, IdleLoopBudgetState> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: Record<string, IdleLoopBudgetState> = {};
      for (const [userId, state] of Object.entries(parsed)) {
        if (isBudgetState(state)) out[userId] = state;
      }
      return out;
    } catch {
      return {};
    }
  };
  const writeAll = (all: Record<string, IdleLoopBudgetState>): void => {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(all, null, 2), "utf8");
    } catch {
      // Budget persistence is best-effort: a failed write must not break the loop.
    }
  };
  const current = (all: Record<string, IdleLoopBudgetState>, userId: string): IdleLoopBudgetState => {
    const date = utcToday(todayFn);
    const stored = all[userId];
    if (stored && stored.date === date) return stored;
    const fresh = freshBudgetState(date);
    all[userId] = fresh;
    return fresh;
  };
  return {
    load(userId) {
      return { ...current(readAll(), userId) };
    },
    recordAction(userId) {
      const all = readAll();
      current(all, userId).actions += 1;
      writeAll(all);
    },
    recordFailure(userId) {
      const all = readAll();
      current(all, userId).failed = true;
      writeAll(all);
    },
  };
}

let sharedBudgetStore: IdleLoopBudgetStore | null = null;

/** Process-wide budget store (one file, shared by every user's loop). */
export function getIdleLoopBudgetStore(): IdleLoopBudgetStore {
  if (!sharedBudgetStore) sharedBudgetStore = createFileBudgetStore();
  return sharedBudgetStore;
}

/** Clamp a requested per-iteration token budget to the hard cap. */
export function resolveTokenBudget(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_TOKENS_PER_ITERATION;
  }
  return Math.max(1, Math.min(Math.floor(requested), HARD_CAP_TOKENS_PER_ITERATION));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a proposed piece of work against the allowlist/denylist. */
export function validateProposal(
  input: unknown,
): { ok: true; proposal: CreativeProposal } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: "proposal is not an object" };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  const area = input.area;
  if (title.length === 0) return { ok: false, reason: "proposal has no title" };
  if (title.length > MAX_PROPOSAL_TITLE_LEN) {
    return { ok: false, reason: "proposal title exceeds 200 characters" };
  }
  if (description.length === 0) {
    return { ok: false, reason: "proposal has no description" };
  }
  if (description.length > MAX_PROPOSAL_DESCRIPTION_LEN) {
    return { ok: false, reason: "proposal description exceeds 2000 characters" };
  }
  if (typeof area !== "string" || !(ALLOWED_AREAS as readonly string[]).includes(area)) {
    return {
      ok: false,
      reason: `proposal area "${String(area)}" is not allowed (allowed: ${ALLOWED_AREAS.join(", ")})`,
    };
  }
  const files = input.files;
  if (files !== undefined) {
    if (
      !Array.isArray(files) ||
      files.some((f) => typeof f !== "string")
    ) {
      return { ok: false, reason: "proposal files must be an array of strings" };
    }
    for (const file of files as string[]) {
      if (
        file.startsWith("/") ||
        file.includes("..") ||
        !(file.startsWith("apps/swarmagents/") || file.startsWith("docs/"))
      ) {
        return {
          ok: false,
          reason: `proposal file "${file}" is outside apps/swarmagents/ or docs/`,
        };
      }
    }
  }
  const haystack = [title, description, ...((files as string[] | undefined) ?? [])].join("\n");
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(haystack)) {
      return {
        ok: false,
        reason: `proposal touches a forbidden topic (matched ${pattern})`,
      };
    }
  }
  return {
    ok: true,
    proposal: {
      title,
      description,
      area: area as CreativeArea,
      ...(files !== undefined ? { files: files as string[] } : {}),
    },
  };
}

/** Build the bounded repo digest the LLM proposal is grounded in. */
export function buildRepoDigest(input: RepoDigestInput): string {
  const sections: string[] = [];
  const tasks = (input.openTasks ?? []).slice(0, MAX_DIGEST_ITEMS);
  if (tasks.length > 0) {
    sections.push(
      `Open board tasks (${tasks.length}):\n` +
        tasks.map((t) => `- ${t.title}`).join("\n"),
    );
  }
  const commits = (input.recentCommits ?? []).slice(0, MAX_DIGEST_ITEMS);
  if (commits.length > 0) {
    sections.push(`Recent commits:\n` + commits.map((c) => `- ${c}`).join("\n"));
  }
  const gaps = (input.knownGaps ?? []).slice(0, MAX_DIGEST_ITEMS);
  if (gaps.length > 0) {
    sections.push(`Known gaps:\n` + gaps.map((g) => `- ${g}`).join("\n"));
  }
  const digest = sections.join("\n\n");
  return digest.length > MAX_DIGEST_CHARS
    ? digest.slice(0, MAX_DIGEST_CHARS)
    : digest;
}

export const IDLE_LOOP_INSTRUCTIONS = [
  "You are A1, the always-on agent for the SwarmAgents product (an agent with",
  "its own visible Linux desktop VM). The product has no user task right now.",
  "Propose ONE concrete improvement you could implement in a single pull",
  "request: a UI polish, a piece of content, a small feature, a test, or a",
  "real fix. It must be grounded in the repo digest below — prefer work that",
  "closes a known gap or an open task, and never propose billing, deploys,",
  "secrets/credentials, auth changes, user-data handling, or anything",
  "destructive. Reply with JSON only, no prose:",
  '{"title": "...", "description": "...", "area": "ui|content|tests|feature|fix", "files": ["apps/swarmagents/..."]}',
].join("\n");

export function buildIdleLoopPrompt(digest: string): string {
  return `${IDLE_LOOP_INSTRUCTIONS}\n\nRepo digest:\n${digest}`;
}

/** Extract the JSON proposal object from the LLM's reply (tolerates prose around it). */
export function parseProposalResponse(
  text: string,
): { ok: true; proposal: CreativeProposal } | { ok: false; reason: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, reason: "LLM reply contains no JSON object" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "LLM reply is not valid JSON" };
  }
  return validateProposal(parsed);
}

export type IdleLoopEventType =
  | "idle-loop.proposed"
  | "idle-loop.rejected"
  | "idle-loop.dispatched"
  | "idle-loop.pr"
  | "idle-loop.skipped";

export interface IdleLoopEvent {
  type: IdleLoopEventType;
  userId: string;
  reason?: string;
  proposal?: CreativeProposal;
  taskId?: string;
  runId?: string;
  branch?: string;
  prUrl?: string;
  tokensUsed?: number;
}

export interface LlmCallResult {
  text: string;
  tokensUsed?: number;
}

export interface IdleLoopDeps {
  userId: string;
  env?: Record<string, string | undefined>;
  isIdle: () => boolean | Promise<boolean>;
  gatherDigest: () => RepoDigestInput | Promise<RepoDigestInput>;
  /** Open tasks (description included so the loop can recognise its own per-user proposals). */
  listOpenTasks: () => Array<{ id: string; title: string; description?: string }> | Promise<Array<{ id: string; title: string; description?: string }>>;
  llmCall: (prompt: string, opts: { maxTokens: number }) => Promise<LlmCallResult>;
  createBoardTask: (proposal: CreativeProposal) => Promise<{ id: string }>;
  implementTask: (args: {
    taskId: string;
    proposal: CreativeProposal;
  }) => Promise<{ branch?: string; prUrl?: string; runId?: string }>;
  /** Persisted daily budget (cap + failure latch). Shared across ticks and restarts. */
  budget: IdleLoopBudgetStore;
  emit?: (event: IdleLoopEvent) => void;
  maxTokensPerIteration?: number;
}

export type IdleIterationStatus =
  | "done"
  | "proposed"
  | "capped"
  | "duplicate"
  | "rejected"
  | "not-idle"
  | "disabled"
  | "paused"
  | "already-running"
  | "stopped";

export interface IdleIterationResult {
  status: IdleIterationStatus;
  reason?: string;
  proposal?: CreativeProposal;
  taskId?: string;
  branch?: string;
  prUrl?: string;
  runId?: string;
  tokensUsed?: number;
}

function emit(deps: IdleLoopDeps, event: IdleLoopEvent): void {
  try {
    deps.emit?.(event);
  } catch {
    // Telemetry must never break the loop.
  }
}

/**
 * Run ONE idle iteration. Pure w.r.t. the loop's own state: the caller owns
 * the concurrency guard (see createIdleLoop, one handle per user).
 *
 * Steps: enabled? paused? failure latch? idle? daily cap? propose (one
 * bounded LLM call) -> validate -> dedupe against this user's own open
 * proposals -> kill-switch re-check -> create board task -> STOP (propose-only
 * default) or, only with SWARM_A1_IDLE_LOOP_DISPATCH=1, dispatch through the
 * normal approval gateway (fullAuto: false). A failed or refused dispatch
 * latches the loop off for the rest of the day.
 */
export async function runIdleIteration(
  deps: IdleLoopDeps,
): Promise<IdleIterationResult> {
  const env = deps.env ?? process.env;
  const userId = deps.userId;
  if (!isIdleLoopEnabled(env)) {
    emit(deps, { type: "idle-loop.skipped", userId, reason: "disabled" });
    return { status: "disabled", reason: "SWARM_A1_IDLE_LOOP is not 1" };
  }
  const openTasks = await deps.listOpenTasks();
  if (isIdleLoopPaused(openTasks)) {
    emit(deps, { type: "idle-loop.skipped", userId, reason: "paused" });
    return { status: "paused", reason: `open task carries ${A1_IDLE_LOOP_PAUSE_MARKER}` };
  }
  // Failure latch: a dispatch that failed or was refused earlier today stops
  // the loop until tomorrow instead of retrying every 5 minutes.
  const budget = deps.budget.load(userId);
  if (budget.failed) {
    emit(deps, { type: "idle-loop.skipped", userId, reason: "failed-earlier-today" });
    return {
      status: "stopped",
      reason: "an implementation dispatch failed or was refused earlier today",
    };
  }
  if (!(await deps.isIdle())) {
    emit(deps, { type: "idle-loop.skipped", userId, reason: "not-idle" });
    return { status: "not-idle", reason: "the user has an active or queued run" };
  }
  // Hard daily cap, checked before spending LLM tokens on a proposal.
  const dailyCap = resolveDailyCap(env);
  if (budget.actions >= dailyCap) {
    emit(deps, { type: "idle-loop.skipped", userId, reason: "capped" });
    return {
      status: "capped",
      reason: `daily cap reached (${budget.actions}/${dailyCap} loop outputs today)`,
    };
  }
  const digest = buildRepoDigest(await deps.gatherDigest());
  const maxTokens = resolveTokenBudget(deps.maxTokensPerIteration);
  const llm = await deps.llmCall(buildIdleLoopPrompt(digest), { maxTokens });
  const parsed = parseProposalResponse(llm.text);
  if (!parsed.ok) {
    emit(deps, {
      type: "idle-loop.rejected",
      userId,
      reason: parsed.reason,
      tokensUsed: llm.tokensUsed,
    });
    return { status: "rejected", reason: parsed.reason, tokensUsed: llm.tokensUsed };
  }
  const proposal = parsed.proposal;
  // Per-user dedupe: the board is shared, so only this user's own open
  // loop proposals (stamped with the per-user marker) count.
  const marker = idleLoopUserMarker(userId);
  const duplicate = openTasks.some(
    (task) =>
      task.description?.includes(marker) &&
      task.title.trim().toLowerCase() === proposal.title.trim().toLowerCase(),
  );
  if (duplicate) {
    emit(deps, {
      type: "idle-loop.skipped",
      userId,
      reason: "duplicate",
      proposal,
      tokensUsed: llm.tokensUsed,
    });
    return {
      status: "duplicate",
      reason: "an open loop task for this user already proposes this",
      proposal,
      tokensUsed: llm.tokensUsed,
    };
  }
  emit(deps, {
    type: "idle-loop.proposed",
    userId,
    proposal,
    tokensUsed: llm.tokensUsed,
  });
  // Kill-switch re-check BEFORE creating the board task: a loop killed
  // mid-iteration creates nothing new.
  if (!isIdleLoopEnabled(env)) {
    emit(deps, {
      type: "idle-loop.skipped",
      userId,
      reason: "stopped",
      proposal,
      tokensUsed: llm.tokensUsed,
    });
    return {
      status: "stopped",
      reason: "kill-switch flipped mid-iteration; no task created",
      proposal,
      tokensUsed: llm.tokensUsed,
    };
  }
  const task = await deps.createBoardTask(proposal);
  // Propose-only by default: the board task is the output. Stop here unless
  // dispatch is explicitly enabled with its own flag.
  if (!isDispatchEnabled(env)) {
    deps.budget.recordAction(userId);
    return {
      status: "proposed",
      proposal,
      taskId: task.id,
      tokensUsed: llm.tokensUsed,
    };
  }
  // Dispatch path (opt-in only): kill-switch re-check, then dispatch.
  if (!isIdleLoopEnabled(env)) {
    deps.budget.recordAction(userId);
    emit(deps, {
      type: "idle-loop.skipped",
      userId,
      reason: "stopped",
      proposal,
      taskId: task.id,
      tokensUsed: llm.tokensUsed,
    });
    return {
      status: "stopped",
      reason: "kill-switch flipped before dispatch; task left open for a worker",
      proposal,
      taskId: task.id,
      tokensUsed: llm.tokensUsed,
    };
  }
  let implemented: { branch?: string; prUrl?: string; runId?: string };
  try {
    implemented = await deps.implementTask({ taskId: task.id, proposal });
  } catch (error) {
    // First failed or refused dispatch latches the loop off for the day.
    deps.budget.recordFailure(userId);
    emit(deps, {
      type: "idle-loop.skipped",
      userId,
      reason: "dispatch-failed",
      proposal,
      taskId: task.id,
      tokensUsed: llm.tokensUsed,
    });
    return {
      status: "stopped",
      reason: `implementation dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      proposal,
      taskId: task.id,
      tokensUsed: llm.tokensUsed,
    };
  }
  deps.budget.recordAction(userId);
  if (implemented.prUrl) {
    emit(deps, {
      type: "idle-loop.pr",
      userId,
      proposal,
      taskId: task.id,
      branch: implemented.branch,
      prUrl: implemented.prUrl,
      runId: implemented.runId,
      tokensUsed: llm.tokensUsed,
    });
  } else {
    emit(deps, {
      type: "idle-loop.dispatched",
      userId,
      proposal,
      taskId: task.id,
      runId: implemented.runId,
      tokensUsed: llm.tokensUsed,
    });
  }
  return {
    status: "done",
    proposal,
    taskId: task.id,
    branch: implemented.branch,
    prUrl: implemented.prUrl,
    runId: implemented.runId,
    tokensUsed: llm.tokensUsed,
  };
}

export interface IdleLoopHandle {
  runOnce: () => Promise<IdleIterationResult>;
  start: (intervalMs?: number) => void;
  stop: () => void;
  isRunning: () => boolean;
}

/**
 * Own the loop's concurrency guard and ticker. runOnce never overlaps
 * itself; start() is idempotent; stop() clears the timer and the next
 * kill-switch check aborts any in-flight iteration before it dispatches.
 */
export function createIdleLoop(
  deps: IdleLoopDeps,
  timers: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  } = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval },
): IdleLoopHandle {
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const runOnce = async (): Promise<IdleIterationResult> => {
    if (running) {
      emit(deps, { type: "idle-loop.skipped", userId: deps.userId, reason: "already-running" });
      return { status: "already-running", reason: "an iteration is already in flight" };
    }
    if (stopped) {
      return { status: "stopped", reason: "loop was stopped" };
    }
    running = true;
    try {
      return await runIdleIteration(deps);
    } finally {
      running = false;
    }
  };

  return {
    runOnce,
    start: (intervalMs: number = DEFAULT_IDLE_LOOP_INTERVAL_MS) => {
      if (timer) return;
      stopped = false;
      const tick = () => {
        void runOnce().catch((error) =>
          console.error("[idle-loop] tick", error),
        );
      };
      timer = timers.setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop: () => {
      stopped = true;
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
    isRunning: () => running,
  };
}

/** Minimal runtime surface the idle check needs (structural: RuntimeManager satisfies it). */
export interface IdleLoopRuntime {
  list(userId: string): Array<{ status: string }>;
  vmManager: { hasActiveExec(userId: string): boolean };
}

/**
 * Is the user idle? Only the user's own runs count: an active exec on
 * their VM, or an active/queued run (a run that `runtime.start` accepted
 * is in the queue or active immediately, even before the exec starts).
 * The shared board is deliberately NOT consulted — it always has open
 * tasks, and other people's tasks say nothing about this user's idleness.
 * Finished/error/cancelled history does not count as busy.
 */
export function isUserIdle(
  runtime: IdleLoopRuntime,
  userId: string,
): boolean {
  try {
    if (runtime.vmManager.hasActiveExec(userId)) return false;
  } catch {
    return false;
  }
  try {
    return !runtime
      .list(userId)
      .some((run) => run.status === "running" || run.status === "queued");
  } catch {
    return false;
  }
}

/**
 * The proposal LLM call's forward options. No hard-coded model: the body
 * carries no model id at all, `requestedModel: "fast"` asks each provider
 * for its fast-tier model, and `useRoutedModel` puts the router-selected
 * model into the request body. The router orders providers by the user's
 * settings, so preferFreeProviders is respected and the call never bills
 * the owner's key for a model the user did not choose.
 */
export function buildIdleLoopLlmOptions(
  userId: string,
  prompt: string,
  maxTokens: number,
): {
  owner: string;
  requestedModel: string;
  useRoutedModel: boolean;
  runId: string;
  body: { messages: Array<{ role: "user"; content: string }>; max_tokens: number; stream: boolean };
} {
  return {
    owner: userId,
    requestedModel: IDLE_LOOP_MODEL_TIER,
    useRoutedModel: true,
    runId: `idle-loop-${userId}`,
    body: {
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    },
  };
}

// ---- production wiring ----

/** Extract plain text from an LLM completion body (Anthropic or OpenAI shape). */
export function extractCompletionText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!isRecord(body)) return "";
  const content = body.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  const choices = body.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first)) {
      const message = first.message;
      if (isRecord(message) && typeof message.content === "string") return message.content;
      if (typeof first.text === "string") return first.text;
    }
  }
  return "";
}

/** System locations for the git binary. Spawning by bare name resolves via
 * PATH, which a writable entry could shadow (Sonar S4036); a literal fixed
 * PATH in `env` did not satisfy the check, so the binary is resolved to an
 * absolute path instead and no PATH lookup happens at all. */
const GIT_PATHS = ["/usr/bin/git", "/usr/local/bin/git"] as const;

function resolveGitPath(): string | undefined {
  for (const candidate of GIT_PATHS) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable candidates
    }
  }
  return undefined;
}

function recentCommitsBestEffort(limit = MAX_DIGEST_ITEMS): string[] {
  const gitPath = resolveGitPath();
  if (!gitPath) return [];
  try {
    const out = execFileSync(gitPath, ["log", `--oneline`, `-${limit}`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Production deps for one user: idle = no active exec on their VM and no
 * active or queued run of theirs (the shared board is not consulted);
 * the proposal LLM call goes through the gateway on the router-chosen fast
 * model (the user's preferFreeProviders respected); proposals become board
 * tasks stamped with this user's marker, for a human or worker to pick up;
 * implementation is dispatched ONLY when SWARM_A1_IDLE_LOOP_DISPATCH=1, as
 * a normal (non-full-auto) run through the approval gateway, whose prompt
 * tells it to claim the task it was created for first.
 */
export function productionIdleLoopDeps(userId: string): IdleLoopDeps {
  const runtime = getRuntimeManager();
  return {
    userId,
    env: process.env,
    isIdle: () => isUserIdle(runtime, userId),
    gatherDigest: async () => {
      let openTasks: Array<{ id: string; title: string }> = [];
      try {
        openTasks = loadStore()
          .tasks.filter((task) => task.status === "open")
          .map((task) => ({ id: task.id, title: task.title }));
      } catch {
        openTasks = [];
      }
      return { openTasks, recentCommits: recentCommitsBestEffort() };
    },
    listOpenTasks: async () => {
      try {
        return loadStore()
          .tasks.filter((task) => task.status === "open")
          .map((task) => ({
            id: task.id,
            title: task.title,
            description: task.description,
          }));
      } catch {
        return [];
      }
    },
    llmCall: async (prompt, { maxTokens }) => {
      const completion = await forwardLlmNonStreaming(
        buildIdleLoopLlmOptions(userId, prompt, maxTokens),
      );
      const text = extractCompletionText(completion.body);
      const usage = completion.usage as { inputTokens?: number; outputTokens?: number };
      const tokensUsed =
        (typeof usage?.inputTokens === "number" ? usage.inputTokens : 0) +
        (typeof usage?.outputTokens === "number" ? usage.outputTokens : 0);
      return { text, tokensUsed };
    },
    createBoardTask: async (proposal) => {
      const store = loadStore();
      const created = await handleCreateTask(
        store,
        {
          title: proposal.title,
          description: `${proposal.description}\n\nProposed by the A1 idle loop ${idleLoopUserMarker(userId)} (area: ${proposal.area}).`,
          difficulty: "medium",
          constraints: [
            "apps/swarmagents/ only",
            "typecheck + lint + build + test:full must exit 0",
          ],
        },
        "a1-idle-loop",
      );
      if ("error" in created) {
        throw new Error(`board task creation failed: ${created.error.message}`);
      }
      const payload = JSON.parse(created.result.content[0]?.text ?? "{}") as {
        task?: { id?: string };
      };
      const id = payload.task?.id;
      if (!id) throw new Error("board task creation returned no id");
      return { id };
    },
    implementTask: async ({ taskId, proposal }) => {
      await runtime.vmManager.ensure(userId);
      // Normal approval gateway, never fullAuto: the run's irreversible
      // steps ask a human first. fullAuto: false is explicit so a server
      // SWARM_FULL_AUTO=1 cannot silently re-enable it.
      const started = runtime.start(userId, {
        prompt: [
          `Implement board task ${taskId}: ${proposal.title}`,
          proposal.description,
          `First, claim board task ${taskId} on the swarm board, so other workers know it is taken. Then implement it on a branch, run the gates (typecheck, test:fast, lint, build), open a PR, and submit your work on the board. Then stop.`,
        ].join("\n\n"),
        fullAuto: false,
      });
      if (!started.accepted) {
        throw new Error(started.error ?? "run refused");
      }
      return { runId: started.runId };
    },
    budget: getIdleLoopBudgetStore(),
    emit: (event) => {
      console.info("[idle-loop]", JSON.stringify(event));
    },
  };
}

let idleLoopTimers: Array<ReturnType<typeof setInterval>> = [];

/**
 * One loop object per user, kept at module level. This is what makes the
 * "never two iterations concurrently" guard real: a fresh loop per tick
 * would never see the previous iteration. Loops for users who leave the
 * always-on list are stopped and dropped.
 */
const idleLoopsByUser = new Map<string, IdleLoopHandle>();

/**
 * One tick for a set of users, reusing each user's loop object. Exported
 * so tests can drive overlapping ticks without waiting on the real timer.
 * Returns one result per user, in the order given.
 */
export async function tickIdleLoops(
  depsForUser: (userId: string) => IdleLoopDeps,
  userIds: string[],
): Promise<IdleIterationResult[]> {
  const wanted = new Set(userIds);
  for (const [userId, loop] of [...idleLoopsByUser]) {
    if (!wanted.has(userId)) {
      loop.stop();
      idleLoopsByUser.delete(userId);
    }
  }
  const results: IdleIterationResult[] = [];
  for (const userId of userIds) {
    let loop = idleLoopsByUser.get(userId);
    if (!loop) {
      loop = createIdleLoop(depsForUser(userId));
      idleLoopsByUser.set(userId, loop);
    }
    results.push(await loop.runOnce());
  }
  return results;
}

/** For tests: how many per-user loop objects are currently held. */
export function idleLoopCountForTesting(): number {
  return idleLoopsByUser.size;
}

/**
 * Poll every always-on user for idle time in the background (module-level
 * intervals, unref'd so they never keep the process alive by itself).
 * Idempotent; a failed tick logs and the next one retries. Started from
 * instrumentation.ts next to startScheduleTicks(), and only when
 * SWARM_A1_IDLE_LOOP=1. The user list is re-read every tick from
 * SWARM_VM_ALWAYS_ON_USERS, so users added later are picked up.
 */
export function startIdleLoopTicks(
  intervalMs: number = DEFAULT_IDLE_LOOP_INTERVAL_MS,
): void {
  if (idleLoopTimers.length > 0) return;
  const tick = () => {
    if (!isIdleLoopEnabled(process.env)) return;
    const userIds = parseAlwaysOnUsers(process.env.SWARM_VM_ALWAYS_ON_USERS);
    void tickIdleLoops(productionIdleLoopDeps, userIds).catch((error) =>
      console.error("[idle-loop] tick", error),
    );
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  idleLoopTimers.push(timer);
}

export function stopIdleLoopTicksForTesting(): void {
  for (const timer of idleLoopTimers) clearInterval(timer);
  idleLoopTimers = [];
  for (const loop of idleLoopsByUser.values()) loop.stop();
  idleLoopsByUser.clear();
}
