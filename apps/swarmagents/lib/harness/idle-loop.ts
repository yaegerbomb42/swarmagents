/**
 * idle-loop.ts — Always-on A1: LLM-proposed creative work loop (24/7, never idle).
 *
 * Today an agent run ends when its task ends and A1 sits idle. This loop
 * keeps A1 working on its own: when there is no user run active and no open
 * board task A1 can claim, it asks the configured LLM for ONE concrete
 * creative improvement (a UI polish, a piece of content, a small feature, a
 * real fix), grounded in a short repo digest, validates the proposal against
 * an allowlist/denylist, turns it into a board task, dispatches an
 * implementation run, and loops again.
 *
 * Safety, by design:
 * - OFF by default. The loop only runs when SWARM_A1_IDLE_LOOP=1 is set
 *   explicitly. There is no implicit enablement in tests or dev.
 * - Kill-switch: setting SWARM_A1_IDLE_LOOP=0 (or calling stop()) stops the
 *   loop within one iteration — the flag is re-checked before any
 *   implementation is dispatched, so a loop that is killed mid-iteration
 *   never starts new work.
 * - Board pause signal: any open board task whose title contains
 *   "[a1-loop-pause]" pauses the loop until the task is closed.
 * - Denylist: proposals touching billing, deploy, secrets/credentials,
 *   auth, user data, or destructive ops are rejected, never executed.
 * - Token budget: one bounded LLM call per iteration, capped by
 *   HARD_CAP_TOKENS_PER_ITERATION.
 * - Concurrency: an iteration never overlaps another; a second caller gets
 *   an "already-running" result.
 * - No real LLM calls in tests: the LLM call is an injected dependency.
 *
 * The engine is dependency-injected (same pattern as lib/runtime/schedules):
 * unit tests run it with fakes, and production deps live in
 * productionIdleLoopDeps(). The background ticker is started from
 * instrumentation.ts next to startScheduleTicks().
 */

import { execFileSync } from "node:child_process";
import { handleCreateTask } from "../board/handlers";
import { loadStore } from "../board/store";
import { forwardLlmNonStreaming } from "../runtime/llm-gateway";
import { getRuntimeManager } from "../runtime/manager";
import { parseAlwaysOnUsers } from "../vm/idle";

/** Env flag for the kill-switch. The loop only runs when this is exactly "1". */
export const A1_IDLE_LOOP_ENV = "SWARM_A1_IDLE_LOOP";

/** Open board task title marker that pauses the loop until the task closes. */
export const A1_IDLE_LOOP_PAUSE_MARKER = "[a1-loop-pause]";

/** Default token budget for the single proposal LLM call per iteration. */
export const DEFAULT_MAX_TOKENS_PER_ITERATION = 2000;
/** Hard cap: no iteration may ask the LLM for more than this. */
export const HARD_CAP_TOKENS_PER_ITERATION = 4000;

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
  listOpenTasks: () => Array<{ id: string; title: string }> | Promise<Array<{ id: string; title: string }>>;
  llmCall: (prompt: string, opts: { maxTokens: number }) => Promise<LlmCallResult>;
  createBoardTask: (proposal: CreativeProposal) => Promise<{ id: string }>;
  implementTask: (args: {
    taskId: string;
    proposal: CreativeProposal;
  }) => Promise<{ branch?: string; prUrl?: string; runId?: string }>;
  emit?: (event: IdleLoopEvent) => void;
  maxTokensPerIteration?: number;
}

export type IdleIterationStatus =
  | "done"
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
 * the concurrency guard (see createIdleLoop). Steps: enabled? paused?
 * idle? propose (one bounded LLM call) -> validate -> create board task ->
 * re-check the kill-switch -> dispatch implementation -> loop again next tick.
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
  if (!(await deps.isIdle())) {
    emit(deps, { type: "idle-loop.skipped", userId, reason: "not-idle" });
    return { status: "not-idle", reason: "a user run is active or a board task is queued" };
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
  emit(deps, {
    type: "idle-loop.proposed",
    userId,
    proposal,
    tokensUsed: llm.tokensUsed,
  });
  const task = await deps.createBoardTask(proposal);
  // Kill-switch re-check: the flag may have flipped while we were working.
  // A loop killed mid-iteration never starts new work.
  if (!isIdleLoopEnabled(env)) {
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
      reason: "kill-switch flipped mid-iteration; task left open for a worker",
      proposal,
      taskId: task.id,
      tokensUsed: llm.tokensUsed,
    };
  }
  const implemented = await deps.implementTask({ taskId: task.id, proposal });
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

function recentCommitsBestEffort(limit = MAX_DIGEST_ITEMS): string[] {
  try {
    const out = execFileSync("git", ["log", `--oneline`, `-${limit}`], {
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
 * open board task to claim; the proposal LLM call goes through the gateway
 * on the user's configured providers; proposals become board tasks via the
 * board store; implementation is dispatched as a full-auto run whose prompt
 * carries the board task (the run itself branches, gates, opens the PR and
 * submits, like any worker).
 */
export function productionIdleLoopDeps(userId: string): IdleLoopDeps {
  const runtime = getRuntimeManager();
  return {
    userId,
    env: process.env,
    isIdle: () => {
      try {
        if (runtime.vmManager.hasActiveExec(userId)) return false;
      } catch {
        return false;
      }
      try {
        return !loadStore().tasks.some((task) => task.status === "open");
      } catch {
        return false;
      }
    },
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
          .map((task) => ({ id: task.id, title: task.title }));
      } catch {
        return [];
      }
    },
    llmCall: async (prompt, { maxTokens }) => {
      const completion = await forwardLlmNonStreaming({
        owner: userId,
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        },
        runId: `idle-loop-${userId}`,
      });
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
          description: `${proposal.description}\n\nProposed by the A1 idle loop (area: ${proposal.area}).`,
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
      const started = runtime.start(userId, {
        prompt: [
          `Implement board task ${taskId}: ${proposal.title}`,
          proposal.description,
          "Work on a branch, run the gates (typecheck, test:fast, lint, build), open a PR, and submit your work on the board. Then stop.",
        ].join("\n\n"),
        fullAuto: true,
      });
      if (!started.accepted) {
        throw new Error(started.error ?? "run refused");
      }
      return { runId: started.runId };
    },
    emit: (event) => {
      console.info("[idle-loop]", JSON.stringify(event));
    },
  };
}

let idleLoopTimers: Array<ReturnType<typeof setInterval>> = [];

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
    for (const userId of parseAlwaysOnUsers(process.env.SWARM_VM_ALWAYS_ON_USERS)) {
      const loop = createIdleLoop(productionIdleLoopDeps(userId));
      void loop.runOnce().catch((error) => console.error("[idle-loop] tick", error));
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  idleLoopTimers.push(timer);
}

export function stopIdleLoopTicksForTesting(): void {
  for (const timer of idleLoopTimers) clearInterval(timer);
  idleLoopTimers = [];
}
