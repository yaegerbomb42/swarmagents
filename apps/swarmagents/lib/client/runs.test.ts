import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTACHMENTS_ONLY_PROMPT,
  MAX_AGENT_CARD_LEN,
  RUNS_ENDPOINT,
  TASKS_ENDPOINT,
  buildRunRequest,
  fetchRuns,
  resetVm,
  resumeRun,
  startNewThread,
  startRun,
  stopRun,
  withUploadManifest,
} from "./runs";

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fetch that records each call and answers from `respond`. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sentBody(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

test("buildRunRequest sends the trimmed prompt and the approvals mode", () => {
  assert.deepEqual(buildRunRequest({ prompt: "  Build a thing  ", fullAuto: true }), {
    prompt: "Build a thing",
    autoApprove: true,
    fullAuto: true,
  });
  assert.deepEqual(buildRunRequest({ prompt: "Ship it", fullAuto: false }), {
    prompt: "Ship it",
    autoApprove: false,
    fullAuto: false,
  });
});

test("buildRunRequest includes the session, instructions and computer only when set", () => {
  const body = buildRunRequest({
    prompt: "Continue",
    fullAuto: true,
    sessionId: "sess_9",
    agentCard: "  Be brief.  ",
    computeTarget: "computer:abc",
  });
  assert.deepEqual(body, {
    prompt: "Continue",
    agentCard: "Be brief.",
    autoApprove: true,
    fullAuto: true,
    sessionId: "sess_9",
    computeTarget: "computer:abc",
  });
  assert.equal("agentCard" in buildRunRequest({ prompt: "x", fullAuto: true, agentCard: "   " }), false);
});

test("buildRunRequest caps the instructions and names an attachments-only message", () => {
  const long = "a".repeat(MAX_AGENT_CARD_LEN + 50);
  assert.equal(String(buildRunRequest({ prompt: "x", fullAuto: true, agentCard: long }).agentCard).length, MAX_AGENT_CARD_LEN);
  assert.equal(buildRunRequest({ prompt: "   ", fullAuto: true }).prompt, ATTACHMENTS_ONLY_PROMPT);
});

test("withUploadManifest lists uploaded files after the message", () => {
  assert.equal(withUploadManifest("Read this", []), "Read this");
  assert.equal(
    withUploadManifest("Read this", ["/workspace/uploads/a.txt", "/workspace/uploads/b.png"]),
    "Read this\n\nUploaded files (in /workspace/uploads/):\n- /workspace/uploads/a.txt\n- /workspace/uploads/b.png",
  );
});

test("startRun posts JSON to the tasks route and returns the run", async () => {
  const { fetchImpl, calls } = fakeFetch(() => json({ runId: "run_1" }, 201));
  const result = await startRun({ prompt: "Build a thing", fullAuto: true }, { fetchImpl });

  assert.deepEqual(result, { ok: true, runId: "run_1", queued: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TASKS_ENDPOINT);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new Headers(calls[0].init?.headers).get("content-type"), "application/json");
  assert.deepEqual(sentBody(calls[0]), { prompt: "Build a thing", autoApprove: true, fullAuto: true });
});

test("startRun reports a queued run and its place in line", async () => {
  const { fetchImpl } = fakeFetch(() => json({ runId: "run_2", queued: true, position: 2 }, 202));
  assert.deepEqual(await startRun({ prompt: "Next", fullAuto: true }, { fetchImpl }), {
    ok: true,
    runId: "run_2",
    queued: true,
    position: 2,
  });
});

test("startRun turns a refusal into the server's own message", async () => {
  const signedOut = fakeFetch(() => json({ error: "Sign in required." }, 401));
  assert.deepEqual(await startRun({ prompt: "x", fullAuto: true }, { fetchImpl: signedOut.fetchImpl }), {
    ok: false,
    error: "Sign in required.",
    status: 401,
  });

  const noBody = fakeFetch(() => new Response("oops", { status: 500 }));
  assert.deepEqual(await startRun({ prompt: "x", fullAuto: true }, { fetchImpl: noBody.fetchImpl }), {
    ok: false,
    error: "HTTP 500",
    status: 500,
  });
});

test("startRun never throws: network failures, aborts and empty answers come back as errors", async () => {
  const offline = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await startRun({ prompt: "x", fullAuto: true }, { fetchImpl: offline.fetchImpl }), {
    ok: false,
    error: "fetch failed",
  });

  const aborted = fakeFetch(() => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  const abortedResult = await startRun({ prompt: "x", fullAuto: true }, { fetchImpl: aborted.fetchImpl });
  assert.equal(abortedResult.ok, false);
  assert.equal(abortedResult.ok === false && abortedResult.aborted, true);

  const noRun = fakeFetch(() => json({}, 201));
  const noRunResult = await startRun({ prompt: "x", fullAuto: true }, { fetchImpl: noRun.fetchImpl });
  assert.equal(noRunResult.ok, false);
  assert.match(noRunResult.ok === false ? noRunResult.error : "", /returned no run/);
});

test("stopRun deletes the run by id", async () => {
  const { fetchImpl, calls } = fakeFetch(() => json({ ok: true }));
  assert.deepEqual(await stopRun("run a/1", fetchImpl), { ok: true });
  assert.equal(calls[0].url, `${TASKS_ENDPOINT}?runId=run%20a%2F1`);
  assert.equal(calls[0].init?.method, "DELETE");

  const refused = fakeFetch(() => json({ error: "No such run." }, 404));
  assert.deepEqual(await stopRun("run_x", refused.fetchImpl), { ok: false, error: "No such run." });
});

test("new chat, VM reset and resume post their actions", async () => {
  const thread = fakeFetch(() => json({ ok: true }));
  assert.deepEqual(await startNewThread(thread.fetchImpl), { ok: true });
  assert.deepEqual(sentBody(thread.calls[0]), { action: "new_thread" });

  const wipe = fakeFetch(() => json({ ok: true }));
  assert.deepEqual(await resetVm(wipe.fetchImpl), { ok: true });
  assert.deepEqual(sentBody(wipe.calls[0]), { action: "wipe_vm" });

  const resume = fakeFetch(() => json({ runId: "run_3" }));
  assert.deepEqual(await resumeRun("run_2", resume.fetchImpl), { ok: true, runId: "run_3", queued: true });
  assert.deepEqual(sentBody(resume.calls[0]), { action: "resume", runId: "run_2" });

  const failed = fakeFetch(() => json({ error: "The computer is offline." }, 409));
  assert.deepEqual(await resumeRun("run_2", failed.fetchImpl), {
    ok: false,
    error: "The computer is offline.",
    status: 409,
  });
});

test("fetchRuns reads the runs route and reports why it could not", async () => {
  const ok = fakeFetch(() => json({ runs: [{ runId: "run_1", status: "finished", prompt: "x", createdAt: 1 }] }));
  const result = await fetchRuns("limit=20", { fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls[0].url, `${RUNS_ENDPOINT}?limit=20`);
  assert.equal(result.ok && result.runs.length, 1);

  const signedOut = fakeFetch(() => json({ error: "Sign in required." }, 401));
  assert.deepEqual(await fetchRuns("limit=20", { fetchImpl: signedOut.fetchImpl }), { ok: false, status: 401 });

  const offline = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await fetchRuns("limit=20", { fetchImpl: offline.fetchImpl }), { ok: false });

  const malformed = fakeFetch(() => json({ nope: true }));
  assert.deepEqual(await fetchRuns("limit=20", { fetchImpl: malformed.fetchImpl }), { ok: true, runs: [] });
});
