/**
 * The three flows, end to end against the real route handlers.
 *
 *   A/B  composer → run client → POST /api/runtime/tasks → RuntimeManager →
 *        VM → GET /api/runtime/runs → the conversation
 *   C    board request → claim → run on the VM → submit for review, through
 *        /api/mcp/swarm-board
 *
 * Nothing in the app is mocked. The only stand-in is the VM driver, which
 * replays a recorded `claude --output-format stream-json` transcript (the same
 * approach as app/api/runtime/tasks/route.test.ts), so no Docker is needed.
 * The provider key below is a fake, as every credential in a test must be.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET as boardGet, POST as boardPost } from "../../app/api/mcp/swarm-board/route";
import { GET as runsGet } from "../../app/api/runtime/runs/route";
import { DELETE as tasksDelete, GET as tasksGet, POST as tasksPost } from "../../app/api/runtime/tasks/route";
import { GET as threadsGet } from "../../app/api/runtime/threads/route";
import { USER_HEADER } from "../../lib/auth";
import { configureStorePaths } from "../../lib/board/store";
import {
  agentNameForUser,
  buildTaskPrompt,
  claimBoardTask,
  createBoardTask,
  extractBranchAndPr,
  fetchBoard,
  submitBoardTask,
  taskFromMessage,
} from "../../lib/client/board";
import { RUN_PHASE_META, deriveRunPhase } from "../../lib/client/runPhase";
import { fetchRuns, startNewThread, startRun, stopRun, type StartRunResult } from "../../lib/client/runs";
import { EMPTY_THREAD, threadReducer, type ThreadEntry, type ThreadRunInput } from "../../lib/client/thread";
import { createRouter } from "../../lib/providers";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../lib/runtime/manager";
import { FakeVmDriver } from "../../lib/vm/fake-driver";
import { VmManager } from "../../lib/vm/manager";
import type { ExecOptions, ExecResult, VmHandle } from "../../lib/vm/types";
import { countOf, installBrowserStubs, makeBoard, makeSession, uninstallBrowserStubs } from "./testing/harness";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const REPLY = "The redirect now goes to the dashboard.\n\nBranch: fix/login-redirect\nPR: https://github.com/acme/app/pull/128";

const TRANSCRIPT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_flow", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: REPLY }] } }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_flow", cost_usd: 0.01, duration_ms: 10, num_turns: 1 }),
];

/** A VM whose `claude` replays the transcript, optionally after a delay an abort can cut short. */
class ScriptedVm extends FakeVmDriver {
  constructor(private readonly delayMs = 0) {
    super();
  }

  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(h, cmd, opts);
    if (this.delayMs > 0) {
      // Wait, but wake (and drop the timer) the moment the run is cancelled.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.delayMs);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        if (opts?.signal?.aborted) wake();
        else opts?.signal?.addEventListener("abort", wake, { once: true });
      });
    }
    if (opts?.signal?.aborted) {
      opts?.onStderr?.("aborted\n");
      return { exitCode: 130 };
    }
    for (const line of TRANSCRIPT) opts?.onStdout?.(`${line}\n`);
    return { exitCode: 0 };
  }
}

function installRuntime(driver: FakeVmDriver): void {
  const router = createRouter({
    providers: [{ id: "gw-test", kind: "anthropic", baseUrl: "http://gw", rank: 0, keys: ["sk-test-fake-key-0000"] }],
  });
  setRuntimeManagerForTesting(new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router }));
}

/** A fetch that hands each request to the real handler, signed in as `user` (null: signed out). */
function routeFetch(user: string | null): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (user !== null) headers.set(USER_HEADER, user);
    const req = new NextRequest(url, { method, headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    switch (`${method} ${url.pathname}`) {
      case "POST /api/runtime/tasks":
        return tasksPost(req);
      case "DELETE /api/runtime/tasks":
        return tasksDelete(req);
      case "GET /api/runtime/tasks":
        return tasksGet(req);
      case "GET /api/runtime/runs":
        return runsGet(req);
      case "GET /api/runtime/threads":
        return threadsGet(req);
      case "GET /api/mcp/swarm-board":
        return boardGet(req);
      case "POST /api/mcp/swarm-board":
        return boardPost(req);
      default:
        throw new Error(`the workspace called a route this test does not know: ${method} ${url.pathname}`);
    }
  }) as typeof fetch;
}

/** Poll the runs route, as the page does, until `pred` holds. */
async function waitForRuns(
  fetchImpl: typeof fetch,
  pred: (runs: ThreadRunInput[]) => boolean,
  steps = 500,
): Promise<ThreadRunInput[]> {
  for (let i = 0; i < steps; i += 1) {
    const result = await fetchRuns("limit=20", { fetchImpl });
    assert.equal(result.ok, true, "the runs route answers");
    if (result.ok && pred(result.runs)) return result.runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for the run");
}

const statusOf = (runs: ThreadRunInput[], runId: string) => runs.find((run) => run.runId === runId)?.status;

/** The page's own reduction of the runs route's answer. */
function toEntries(runs: ThreadRunInput[]): ThreadEntry[] {
  return threadReducer(EMPTY_THREAD, { type: "merge", runs, limit: 300 }).entries;
}

async function startOk(input: Parameters<typeof startRun>[0], fetchImpl: typeof fetch) {
  const result = await startRun(input, { fetchImpl });
  if (!result.ok) throw new Error(`the run did not start: ${result.error}`);
  return result;
}

/**
 * Render with the browser stubs in place, then take them away: the server
 * modules these tests call refuse to run while `window` exists.
 */
async function renderInBrowser(build: () => Promise<React.ReactElement>): Promise<string> {
  installBrowserStubs();
  try {
    return renderToStaticMarkup(await build());
  } finally {
    uninstallBrowserStubs();
  }
}

afterEach(() => {
  setRuntimeManagerForTesting(null);
  uninstallBrowserStubs();
});

test("Flow A+B: a sent message becomes a run on the real backend, and its reply shows in the conversation", async () => {
  installRuntime(new ScriptedVm());
  const fetchImpl = routeFetch("flow-alice");
  const { sendDraft } = await import("./components/Composer");

  // The composer hands the text to the run client: the path the page uses.
  let started: StartRunResult | undefined;
  const cleared: string[] = [];
  const sent = await sendDraft(
    { text: "  Fix the login redirect  ", files: [] as never[] },
    {
      onSend: async (text) => {
        started = await startRun({ prompt: text, fullAuto: true, agentCard: "Be brief." }, { fetchImpl });
        return started.ok ? { ok: true } : { ok: false, error: started.error };
      },
      setText: (text) => cleared.push(text),
      setFiles: () => {},
      setError: (error) => assert.equal(error, undefined),
      setSending: () => {},
    },
  );
  assert.equal(sent, true);
  assert.deepEqual(cleared, [""], "the box emptied and nothing was handed back");
  assert.ok(started?.ok);
  const runId = started.ok ? started.runId : "";
  assert.match(runId, /^run_/);

  // The runs route reports it. Wait for the VM to finish the transcript.
  const runs = await waitForRuns(fetchImpl, (list) => statusOf(list, runId) === "finished");
  const entries = toEntries(runs);
  const entry = entries.find((candidate) => candidate.runId === runId);
  assert.ok(entry, "the run is in the page's store");
  assert.equal(entry.prompt, "Fix the login redirect");
  assert.equal(entry.finalText, REPLY);
  assert.equal(entry.sessionId, "sess_flow");
  assert.equal(deriveRunPhase({ status: entry.status }), "finished");

  // The conversation is listed for the next visit: chat survives a refresh.
  const threadsRes = await fetchImpl("/api/runtime/threads?limit=30");
  assert.equal(threadsRes.status, 200);
  const { threads } = (await threadsRes.json()) as { threads: Array<{ id: string; title: string; runCount: number }> };
  assert.deepEqual(
    threads.map((thread) => [thread.id, thread.title, thread.runCount]),
    [["sess_flow", "Fix the login redirect", 1]],
  );
  const bySession = await fetchRuns("limit=50&sessionId=sess_flow", { fetchImpl });
  assert.equal(bySession.ok && bySession.runs.length, 1, "reopening the thread loads its runs");

  // And the turn renders from that data.
  const html = await renderInBrowser(async () => {
    const { Conversation } = await import("./components/Conversation");
    return React.createElement(Conversation, {
      session: makeSession({ turns: [entry], threadKey: "sess_flow" }),
      taskLinks: {},
      onWatchScreen: () => {},
      onOpenTask: () => {},
      onOpenProviders: () => {},
    });
  });
  assert.match(html, new RegExp(`data-run-id="${runId}"[^>]*data-phase="finished"`));
  assert.match(html, /Fix the login redirect/);
  assert.match(html, /The redirect now goes to the dashboard\./);
  assert.match(html, new RegExp(`>${RUN_PHASE_META.finished.label}<`));
  assert.equal(countOf(html, 'data-testid="run-report"'), 1);
});

test("Flow A: Stop cancels the running run; a message sent meanwhile waits in the queue", async () => {
  installRuntime(new ScriptedVm(60_000));
  const fetchImpl = routeFetch("flow-bob");

  const first = await startOk({ prompt: "A long job", fullAuto: true }, fetchImpl);
  assert.equal(first.queued, false);
  await waitForRuns(fetchImpl, (list) => statusOf(list, first.runId) === "running");

  // A follow-up during the run is accepted and queued behind it.
  const second = await startOk({ prompt: "Then this", fullAuto: true }, fetchImpl);
  assert.equal(second.queued, true);
  const during = await waitForRuns(fetchImpl, (list) => statusOf(list, second.runId) === "queued");
  const { pickActiveRunId } = await import("./hooks/useAgentSession");
  assert.equal(pickActiveRunId(during), first.runId, "the header's Stop targets the run that is running");
  assert.equal(deriveRunPhase({ status: statusOf(during, second.runId) }), "queued");

  // The queued message can be cancelled where it stands, without touching the run.
  assert.deepEqual(await stopRun(second.runId, fetchImpl), { ok: true });
  const afterCancel = await waitForRuns(fetchImpl, (list) => statusOf(list, second.runId) !== "queued");
  assert.equal(statusOf(afterCancel, first.runId), "running");

  // Stop ends the run, and the page shows it as Stopped.
  assert.deepEqual(await stopRun(first.runId, fetchImpl), { ok: true });
  const after = await waitForRuns(fetchImpl, (list) => statusOf(list, first.runId) === "cancelled");
  const stopped = toEntries(after).find((entry) => entry.runId === first.runId);
  assert.equal(RUN_PHASE_META[deriveRunPhase({ status: stopped?.status }) ?? "running"].label, "Stopped");

  // With nothing running, a new chat can start.
  assert.deepEqual(await startNewThread(fetchImpl), { ok: true });
});

test("signed out, every call says so instead of failing silently", async () => {
  installRuntime(new ScriptedVm());
  const fetchImpl = routeFetch(null);

  assert.deepEqual(await startRun({ prompt: "Build it", fullAuto: true }, { fetchImpl }), {
    ok: false,
    error: "Sign in required.",
    status: 401,
  });
  assert.deepEqual(await fetchRuns("limit=20", { fetchImpl }), { ok: false, status: 401 });
  assert.deepEqual(await stopRun("run_x", fetchImpl), { ok: false, error: "Sign in required." });
});

test("Flow C: a board task is run on the VM, then submitted for review with the branch and PR from the reply", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-board-"));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  installRuntime(new ScriptedVm());
  const fetchImpl = routeFetch("flow-carol");
  const agentName = agentNameForUser({ id: "flow-carol", email: "carol@example.com" });

  // The user asks the board for work.
  const draft = taskFromMessage("Fix the login redirect\nUsers land on a blank page after sign in.");
  assert.ok(draft);
  const created = await createBoardTask(draft!, fetchImpl);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const task = created.value;

  // Run it: the run starts first, then the task is claimed (as the page does),
  // so a run that fails to start never strands a claimed task.
  const run = await startOk({ prompt: buildTaskPrompt(task), fullAuto: true }, fetchImpl);
  const claimed = await claimBoardTask({ taskId: task.id, agentName }, fetchImpl);
  assert.equal(claimed.ok && claimed.value.status, "claimed");

  const runs = await waitForRuns(fetchImpl, (list) => statusOf(list, run.runId) === "finished");
  const entry = toEntries(runs).find((candidate) => candidate.runId === run.runId);
  assert.ok(entry);
  assert.match(entry.prompt, /^Work on this SwarmBoard task/);

  // The reply carries the branch and the PR the submit form is prefilled with.
  const found = extractBranchAndPr(entry.finalText);
  assert.deepEqual(found, { branch: "fix/login-redirect", prUrl: "https://github.com/acme/app/pull/128" });
  const submitted = await submitBoardTask(
    { taskId: task.id, agentName, gitBranch: found.branch ?? "", summary: entry.finalText ?? "", prUrl: found.prUrl },
    fetchImpl,
  );
  assert.equal(submitted.ok && submitted.value.status, "in_review");

  // The board, read back from the server, renders the result.
  const board = await fetchBoard({ fetchImpl });
  assert.equal(board.ok, true);
  if (!board.ok) return;
  assert.equal(board.value.counts.in_review, 1);

  const link = { taskId: task.id, title: task.title, runId: run.runId, agentName, startedAt: Date.now() };
  const tasks = board.value.tasks;
  const html = await renderInBrowser(async () => {
    const { BoardPanel } = await import("./components/BoardPanel");
    return React.createElement(BoardPanel, {
      board: makeBoard(tasks, { links: { [task.id]: link } }),
      agentName,
      runFor: (runId: string) => (runId === run.runId ? entry : undefined),
      onRunTask: async () => undefined,
      onViewRun: () => {},
      focusTaskId: task.id,
    });
  });
  assert.equal(countOf(html, 'data-testid="board-task"'), 1);
  assert.match(html, new RegExp(`data-task-id="${task.id}"[^>]*data-status="in_review"`));
  assert.match(html, /Fix the login redirect/);
  assert.match(html, />In review</);
  assert.doesNotMatch(html, /carol@example\.com \(VM\)/, "worker names stay off the board rows");
  assert.match(html, /href="https:\/\/github\.com\/acme\/app\/pull\/128"/);
  assert.match(html, /fix\/login-redirect/);
  assert.equal(countOf(html, 'data-testid="board-task-result"'), 1, "the submitted result is on the task");
  assert.equal(countOf(html, 'data-testid="board-view-run"'), 1, "and the task links to its run");
  assert.equal(countOf(html, 'data-testid="board-submit"'), 0, "nothing left to submit");
});
