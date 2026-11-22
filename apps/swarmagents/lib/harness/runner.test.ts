/**
 * Unit tests for ClaudeCodeRunner against a recorded stream-json fixture.
 *
 * The fixture below is a realistic transcript of `claude -p ... --output-format
 * stream-json --verbose`: init, assistant text, tool_use, tool_result (ok and
 * error, string and array content), usage, and a final result event.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeRunner, isBackgroundedCommand, isSignalKillExitCode } from "./runner.js";
import { StateLedger } from "./context/contextGovernor.js";
import { localScorer } from "./system-one/index.js";
import type { DecisionRouter } from "./decision-brain/index.js";
import type { RolePhase, TelemetryEvent, VmExec, VmExecOpts } from "./types.js";

const SECRET_TOKEN = "sk-ant-api03-BENCH-FAKE-TOKEN-0000";
const PLAIN_SECRET = "my-super-secret-key-42";

// --- Recorded fixture (serialized deterministically so the JSON is always valid) ---

const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/home/user",
  session_id: "sess_demo_1",
  model: "claude-sonnet-5-5",
};

const M1 = {
  type: "assistant",
  message: {
    id: "m1",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Hello! Let me inspect the repo." }],
    usage: { input_tokens: 12, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
};

const M2 = {
  type: "assistant",
  message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }] },
};

const T1 = {
  type: "user",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "total 80\ndrwxr-xr-x 16 box box 4096 Nov 11 10:00 .\napp\nlib",
      is_error: false,
    }],
  },
};

const M3 = {
  type: "assistant",
  message: { id: "m3", content: [{ type: "tool_use", id: "toolu_2", name: "Grep", input: { pattern: "api.*key", path: "lib" } }] },
};

// Tool output that echoes secret values back at us — must be redacted.
const T2 = {
  type: "user",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_2",
      content: `secret: ${PLAIN_SECRET} token: ${SECRET_TOKEN}`,
      is_error: false,
    }],
  },
};

const M4 = {
  type: "assistant",
  message: { id: "m4", content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "echo failing" } }] },
};

const T3 = {
  type: "user",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_3",
      content: "bash: line 1: failing: command not found",
      is_error: true,
    }],
  },
};

const M5 = {
  type: "assistant",
  message: {
    id: "m5",
    content: [
      { type: "text", text: "That failed; trying differently." },
      { type: "tool_use", id: "toolu_4", name: "Read", input: { file_path: "package.json" } },
    ],
  },
};

const T4 = {
  type: "user",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_4",
      content: [{ type: "text", text: '{"name":"swarmagents"}' }],
      is_error: false,
    }],
  },
};

const M6 = {
  type: "assistant",
  message: {
    id: "m6",
    content: [{ type: "text", text: "Done." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 48, output_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
  },
};

// Tool input that carries a secret object — must be deep-redacted.
const M7 = {
  type: "assistant",
  message: {
    id: "m7",
    content: [{
      type: "tool_use",
      id: "toolu_5",
      name: "Bash",
      input: { command: `echo ${PLAIN_SECRET}`, env: { TOKEN: SECRET_TOKEN } },
    }],
  },
};

const RESULT = {
  type: "result",
  subtype: "success",
  duration_ms: 3400,
  num_turns: 6,
  result: "Done.",
  session_id: "sess_demo_1",
  cost_usd: 0.021,
};

const FIXTURE_LINES: string[] = [INIT, M1, M2, T1, M3, T2, M4, T3, M5, T4, M6, M7, RESULT].map((l) => JSON.stringify(l));
const FIXTURE = FIXTURE_LINES.join("\n") + "\n";

// --- Scripted VM that replays chunks through the exec interface ---

interface Step {
  chunks?: string[];
  err?: string;
  abortController?: AbortController;
  exitCode?: number;
}

class ScriptedVm implements VmExec {
  calls: Array<{ cmd: string[]; opts: VmExecOpts }> = [];

  constructor(private readonly steps: Step[]) {}

  async exec(cmd: string[], opts?: VmExecOpts): Promise<{ exitCode: number }> {
    this.calls.push({ cmd, opts: opts ?? {} });
    let exitCode = 0;
    for (const step of this.steps) {
      if (opts?.signal?.aborted) {
        exitCode = 130;
        break;
      }
      if (step.chunks) for (const chunk of step.chunks) opts?.onStdout?.(chunk);
      if (step.err !== undefined) opts?.onStderr?.(step.err);
      step.abortController?.abort();
      if (step.exitCode !== undefined) exitCode = step.exitCode;
    }
    // A driver that kills the process on abort reports a nonzero code.
    if (opts?.signal?.aborted && exitCode === 0) exitCode = 130;
    return { exitCode };
  }
}

/** Split a string at deterministic, awkward offsets so lines break mid-way. */
function awkwardChunks(text: string): string[] {
  const points = [7, 41, 133, 355, 777, 1299, 1701, 2233, 2900, Number.MAX_SAFE_INTEGER];
  const chunks: string[] = [];
  let prev = 0;
  for (const p of points) {
    chunks.push(text.slice(prev, p));
    prev = p;
  }
  return chunks.filter((c) => c.length > 0);
}

const envWithSecrets = { ANTHROPIC_API_KEY: SECRET_TOKEN, MY_API_KEY: PLAIN_SECRET };

test("builds argv correctly and passes provider keys via env only, never argv", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run(
    {
      prompt: "Inspect repo",
      sessionId: "sess_resume_x",
      model: "claude-sonnet-5-5",
      env: envWithSecrets,
      vm,
    },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.malformedLines, 0);

  assert.equal(vm.calls.length, 1);
  const { cmd, opts } = vm.calls[0];
  assert.deepEqual(cmd, [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    "sess_resume_x",
    "--model",
    "claude-sonnet-5-5",
    "--",
    "Inspect repo",
  ]);
  assert.deepEqual(opts.env, envWithSecrets);
  for (const secret of [SECRET_TOKEN, PLAIN_SECRET]) {
    assert.ok(!cmd.some((arg) => arg.includes(secret)), `argv leaked ${secret}`);
  }
  // No emitted event may contain either secret.
  for (const secret of [SECRET_TOKEN, PLAIN_SECRET]) {
    for (const event of events) {
      assert.ok(!JSON.stringify(event).includes(secret), `event leaked ${secret}`);
    }
  }
});

test("appends the agent card as --append-system-prompt, one argv element per value", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  // Deliberately ugly card: whitespace, newlines, and a dash-leading fragment —
  // it must survive verbatim as its own argument, never shell-interpolated.
  const card = "  I am your autonomous engineer.\n- Finish the goal.\n--risky-looking\n";
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run(
    {
      prompt: "Inspect repo",
      agentCard: card,
      env: envWithSecrets,
      vm,
    },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(vm.calls.length, 1);
  const cmd = vm.calls[0].cmd;
  const idx = cmd.indexOf("--append-system-prompt");
  assert.ok(idx !== -1, "argv should include --append-system-prompt");
  assert.equal(cmd[idx + 1], card, "card must be its own argv element, verbatim");
  assert.deepEqual(cmd.slice(0, idx), ["claude", "-p", "--output-format", "stream-json", "--verbose"]);
  // The card comes before `--` and the user prompt.
  assert.equal(cmd[cmd.length - 2], "--");
  assert.equal(cmd[cmd.length - 1], "Inspect repo");
});

test("omits --append-system-prompt when no agent card is provided", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner();
  const outcome = await runner.run({ prompt: "x", env: {}, vm }, () => {});
  assert.equal(outcome.exitCode, 0);
  assert.equal(vm.calls[0].cmd.includes("--append-system-prompt"), false);
});

test("L1 context packer packs the invocation prompt and reports the budget line", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner({ bin: "claude", contextPacker: "l1" });
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run(
    {
      prompt: "Inspect repo",
      agentCard: "I am your engineer.",
      memoryContext: "remember the tests",
      sessionId: "sess_resume_x",
      model: "claude-sonnet-5-5",
      env: envWithSecrets,
      vm,
    },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(vm.calls.length, 1);
  const { cmd } = vm.calls[0];

  // An L1 turn is stateless: --resume would replay the whole history.
  assert.equal(cmd.includes("--resume"), false, "L1 packing must drop --resume");
  assert.equal(cmd.includes("sess_resume_x"), false);

  // The packed system header folds in the agent card and memory.
  const idx = cmd.indexOf("--append-system-prompt");
  assert.ok(idx !== -1, "argv should include --append-system-prompt");
  const systemPrompt = cmd[idx + 1];
  assert.match(systemPrompt, /L1 context mode/);
  assert.match(systemPrompt, /I am your engineer/);
  assert.match(systemPrompt, /remember the tests/);

  // The user prompt is the packed ledger.
  const prompt = cmd[cmd.length - 1];
  assert.match(prompt, /## State ledger \(turn 0\)/);
  assert.match(prompt, /Goal: Inspect repo/);

  // The budget ledger line rides in telemetry.
  const budget = events.filter(
    (e): e is Extract<TelemetryEvent, { type: "capability.changed" }> =>
      e.type === "capability.changed" && e.tool === "context",
  );
  assert.equal(budget.length, 1);
  assert.equal(budget[0].ok, true);
  assert.match(budget[0].detail, /^context-packer\[l1\] turn=0 budget=8192 /);
});

test("L1 packer hydrates the state ledger from the request snapshot", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner({ bin: "claude", contextPacker: "l1" });
  const ledger = new StateLedger("Resume the upload fix");
  ledger.recordFailedAttempt(
    "bumping the retry count in lib/upload/retry.ts",
    "upload.test.ts > retries: expected 200, got 500",
    "bumping the retry count again",
    3,
  );
  const outcome = await runner.run(
    {
      prompt: "Ignored when a snapshot is present",
      stateLedger: ledger.toJSON(),
      env: {},
      vm,
    },
    () => {},
  );
  assert.equal(outcome.exitCode, 0);
  const { cmd } = vm.calls[0];
  const prompt = cmd[cmd.length - 1];
  assert.match(prompt, /Goal: Resume the upload fix/);
  assert.match(prompt, /## Do not retry/);
  assert.match(prompt, /bumping the retry count in lib\/upload\/retry\.ts/);
  assert.doesNotMatch(prompt, /Ignored when a snapshot is present/);
});

test("without the packer the argv is byte-identical to today and no context telemetry is emitted", async () => {
  const base = {
    prompt: "Inspect repo",
    agentCard: "card",
    memoryContext: "memory",
    sessionId: "sess_resume_x",
    model: "claude-sonnet-5-5",
    env: envWithSecrets,
  };

  const runOnce = async (runner: ClaudeCodeRunner) => {
    const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
    const events: TelemetryEvent[] = [];
    const outcome = await runner.run({ ...base, vm }, (e) => events.push(e));
    assert.equal(outcome.exitCode, 0);
    return { cmd: vm.calls[0].cmd, events };
  };

  const implicit = await runOnce(new ClaudeCodeRunner());
  const explicit = await runOnce(new ClaudeCodeRunner({ contextPacker: "claude-code" }));

  assert.deepEqual(explicit.cmd, implicit.cmd, "an explicit claude-code setting must not change argv");
  assert.deepEqual(implicit.cmd, [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    "sess_resume_x",
    "--model",
    "claude-sonnet-5-5",
    "--append-system-prompt",
    "card\n\nmemory",
    "--",
    "Inspect repo",
  ]);
  for (const { events } of [implicit, explicit]) {
    assert.equal(
      events.some((e) => e.type === "capability.changed" && (e as { tool?: string }).tool === "context"),
      false,
      "the default packer must emit no context telemetry",
    );
  }
});

test("a per-role packer default applies when neither the run nor the runner sets one", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner({ roleContextPackers: { coder: "l1" } });
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run(
    {
      prompt: "Inspect repo",
      env: {},
      vm,
      rolePhase: { roleId: "coder", allowedTools: ["Read"], mcpConfigPath: "/role.json" },
    },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  const { cmd } = vm.calls[0];
  assert.match(cmd[cmd.length - 1], /## State ledger \(turn 0\)/);
  // Packing keeps the role's tool allowlist and MCP config.
  assert.ok(cmd.includes("--allowedTools"));
  assert.ok(cmd.includes("/role.json"));
  assert.equal(events.filter((e) => e.type === "capability.changed").length, 1);
});

test("a per-run packer override wins over the runner setting and role default", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner({ contextPacker: "l1", roleContextPackers: { coder: "l1" } });
  const events: TelemetryEvent[] = [];
  // Passed as a variable so the optional override is allowed structurally.
  const request = {
    prompt: "Inspect repo",
    env: {},
    vm,
    rolePhase: { roleId: "coder", allowedTools: ["Read"], mcpConfigPath: "/role.json" },
    contextPacker: "claude-code",
  };

  const outcome = await runner.run(request, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const { cmd } = vm.calls[0];
  assert.equal(cmd[cmd.length - 1], "Inspect repo");
  assert.equal(events.some((e) => e.type === "capability.changed"), false);
});

test("parses the full recorded fixture, including partial lines and a malformed line", async () => {
  // Inject one garbage line (right after the init line) and stream everything in
  // awkward chunks so every JSON line is split mid-way at least once.
  const injected = FIXTURE.replace(FIXTURE_LINES[0], `${FIXTURE_LINES[0]}\n BUT THIS IS NOT JSON }`);
  const vm = new ScriptedVm([{ chunks: awkwardChunks(injected) }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "Inspect repo", env: envWithSecrets, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.malformedLines, 1, "garbage line should be skipped, not fatal");

  const started = events.filter((e) => e.type === "run.started");
  assert.equal(started.length, 1);
  assert.equal(started[0].sessionId, "sess_demo_1");
  assert.equal(started[0].model, "claude-sonnet-5-5");
  assert.equal(typeof started[0].startedAt, "number");

  const texts = events.filter((e): e is Extract<TelemetryEvent, { type: "assistant.text" }> => e.type === "assistant.text");
  assert.deepEqual(texts.map((t) => t.text), [
    "Hello! Let me inspect the repo.",
    "That failed; trying differently.",
    "Done.",
  ]);

  const calls = events.filter((e): e is Extract<TelemetryEvent, { type: "tool.call" }> => e.type === "tool.call");
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], { type: "tool.call", name: "Bash", input: { command: "ls -la" }, id: "toolu_1" });
  assert.deepEqual(calls[1].input, { pattern: "api.*key", path: "lib" });
  assert.deepEqual(calls[4].input, { command: `echo [REDACTED]`, env: { TOKEN: "[REDACTED]" } });

  const results = events.filter((e): e is Extract<TelemetryEvent, { type: "tool.result" }> => e.type === "tool.result");
  assert.equal(results.length, 4);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].truncated, false);
  assert.match(results[0].output, /total 80/);
  assert.equal(results[1].ok, true);
  assert.ok(!results[1].output.includes(PLAIN_SECRET), "plain secret must be redacted from tool output");
  assert.ok(!results[1].output.includes(SECRET_TOKEN), "API key must be redacted from tool output");
  assert.ok(results[1].output.includes("secret: [REDACTED]"));
  assert.equal(results[2].ok, false, "is_error tool result must map to ok=false");
  assert.equal(results[3].ok, true);
  assert.match(results[3].output, /\{"name":"swarmagents"\}/);

  const usages = events.filter((e): e is Extract<TelemetryEvent, { type: "usage" }> => e.type === "usage");
  assert.equal(usages.length, 2);
  assert.deepEqual(usages[1], { type: "usage", inputTokens: 48, outputTokens: 30, cachedTokens: 12 });

  const finished = events.filter((e) => e.type === "run.finished");
  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0], {
    type: "run.finished",
    exitCode: 0,
    sessionId: "sess_demo_1",
    costUsd: 0.021,
    durationMs: 3400,
    numTurns: 6,
  });
});

test("emits run.error with stderr detail when the process exits nonzero", async () => {
  const vm = new ScriptedVm([
    {
      chunks: FIXTURE_LINES.slice(0, 3).map((l) => l + "\n"), // init + text + tool call, then dies
      err: "Error: permission denied",
      exitCode: 1,
    },
  ]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.aborted, false);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exited with code 1/);
  assert.match(errors[0].message, /permission denied/);
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("emits run.error when the process exits 0 without a result event", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE_LINES[0] + "\n"] }]); // init only, no result
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.malformedLines, 0);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no result event/);
});

test("reports a clear quota error when truncation cuts off the final stream-json result", async () => {
  const truncatedVm: VmExec = {
    async exec(_cmd, opts) {
      opts?.onStdout?.(`${FIXTURE_LINES[0]}\n{"type":"result","subtype":"success"`);
      return { exitCode: 0, truncated: true };
    },
  };
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm: truncatedVm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /stream-json output was truncated/i);
  assert.match(errors[0].message, /SWARM_VM_AGENT_MAX_OUTPUT_BYTES/);
  assert.ok(!/no result event/i.test(errors[0].message));
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("aborts cleanly: stops emitting and reports run.error", async () => {
  const controller = new AbortController();
  const vm = new ScriptedVm([
    { chunks: [FIXTURE_LINES[0] + "\n"] },
    // A line chopped mid-way, then abort — the partial tail must not be parsed.
    { chunks: ['{"type":"assistant","message":{"id":"m0","content":[{"type":"text","text":"partial'], abortController: controller },
  ]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm, signal: controller.signal }, (e) => events.push(e));

  assert.equal(outcome.aborted, true);
  assert.equal(outcome.malformedLines, 0);
  assert.equal(outcome.exitCode, 130);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 0);
  assert.equal(events.filter((e) => e.type === "run.started").length, 1);
  const last = events[events.length - 1];
  assert.equal(last.type, "run.error");
  assert.match((last as Extract<TelemetryEvent, { type: "run.error" }>).message, /aborted/i);
});

test("redactSecrets scrubs provider keys that never appear in env", async () => {
  const GATEWAY_TOKEN = "sk-gw-fake-token-0000";
  const LEAK_TEXT = `token is ${GATEWAY_TOKEN}`;
  const LEAK_LINE = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: LEAK_TEXT }] },
  });
  const vm = new ScriptedVm([{ chunks: [FIXTURE_LINES[0] + "\n", LEAK_LINE + "\n", FIXTURE_LINES[12] + "\n"] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run(
    {
      prompt: "x",
      env: {}, // the token is not in env
      redactSecrets: [GATEWAY_TOKEN],
      vm,
    },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  const texts = events.filter((e): e is Extract<TelemetryEvent, { type: "assistant.text" }> => e.type === "assistant.text");
  assert.deepEqual(texts.map((t) => t.text), ["token is [REDACTED]"]);
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes(GATEWAY_TOKEN), `event leaked ${GATEWAY_TOKEN}`);
  }
});

test("defaults: no --resume/--model when not requested; run without sessionId", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(vm.calls[0].cmd, ["claude", "-p", "--output-format", "stream-json", "--verbose", "--", "x"]);
  // No sessionId anywhere -> finished falls back to the result event's session.
  const finished = events.find((e) => e.type === "run.finished");
  assert.equal(finished!.sessionId, "sess_demo_1");
});


test("records the provider actually selected on run.started", async () => {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  await runner.run({ prompt: "x", provider: "mercury", env: {}, vm }, (e) => events.push(e));

  const started = events.find((e) => e.type === "run.started");
  assert.equal(started?.provider, "mercury");
});

test("attaches the generating model to usage events so summaries can fill a model gap", async () => {
  const lines = [
    // Init line carries no model and no --model was requested, so run.started
    // has none — the model must arrive on a later llm event instead.
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess_model_gap" }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m-model",
        model: "clarke-1.0",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "sess_model_gap", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
  ].join("\n") + "\n";
  const vm = new ScriptedVm([{ chunks: [lines] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  const started = events.find((e) => e.type === "run.started");
  assert.equal(started?.model, undefined);
  const usages = events.filter((e): e is Extract<TelemetryEvent, { type: "usage" }> => e.type === "usage");
  assert.equal(usages.length, 1);
  assert.equal(usages[0].model, "clarke-1.0");
});

test("reads cumulative usage and total_cost_usd from the final result event", async () => {
  const INIT_ONLY = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess_result_usage",
    model: "claude-real",
  });
  // Real Claude Code builds may omit per-message usage and report the run
  // totals only on `result`; that usage must still be recorded.
  const RESULT_WITH_USAGE = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess_result_usage",
    total_cost_usd: 0.017,
    duration_ms: 1200,
    num_turns: 2,
    usage: {
      input_tokens: 321,
      output_tokens: 45,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 4,
    },
  });
  const vm = new ScriptedVm([{ chunks: [`${INIT_ONLY}\n${RESULT_WITH_USAGE}\n`] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", provider: "anthropic", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const usages = events.filter((e): e is Extract<TelemetryEvent, { type: "usage" }> => e.type === "usage");
  assert.equal(usages.length, 1);
  assert.deepEqual(usages[0], {
    type: "usage",
    inputTokens: 321,
    outputTokens: 45,
    cachedTokens: 64,
  });
  const finished = events.find((e) => e.type === "run.finished") as Extract<TelemetryEvent, { type: "run.finished" }>;
  assert.equal(finished.costUsd, 0.017);

  // run.started must come before usage so the aggregator can attribute it.
  assert.ok(events.findIndex((e) => e.type === "run.started") < events.findIndex((e) => e.type === "usage"));
});

test("zero usage from a provider that reported none emits no usage events", async () => {
  // The proxy surfaces "no usage" to Claude as 0/0 (the provider never sent a
  // usage object). Those are not real counts and must not appear as 0s.
  const NO_USAGE_ASSISTANT = JSON.stringify({
    type: "assistant",
    message: {
      id: "m_no_usage",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  const NO_USAGE_RESULT = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess_no_usage",
    total_cost_usd: 0.0,
    duration_ms: 100,
    num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const vm = new ScriptedVm([{ chunks: [`${JSON.stringify(INIT)}\n${NO_USAGE_ASSISTANT}\n${NO_USAGE_RESULT}\n`] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const usages = events.filter((e): e is Extract<TelemetryEvent, { type: "usage" }> => e.type === "usage");
  assert.equal(usages.length, 0);
});

test("does not double count when both assistant and result usage are present", async () => {
  const ASSISTANT_USAGE = JSON.stringify(M1);
  const RESULT_TOTAL = JSON.stringify({
    ...RESULT,
    usage: { input_tokens: 999, output_tokens: 999 },
  });
  const vm = new ScriptedVm([{ chunks: [`${JSON.stringify(INIT)}\n${ASSISTANT_USAGE}\n${RESULT_TOTAL}\n`] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  const usages = events.filter((e): e is Extract<TelemetryEvent, { type: "usage" }> => e.type === "usage");
  assert.equal(usages.length, 1);
  assert.equal(usages[0].inputTokens, 12);
  assert.equal(usages[0].outputTokens, 9);
});

test("emits computer.action events for desktop MCP calls, with redacted summaries", async () => {
  const DESKTOP_CALLS = [
    {
      type: "assistant",
      message: {
        id: "d1",
        content: [{ type: "tool_use", id: "tu_d1", name: "mcp__computer-mcp__click", input: { x: 44, y: 66 } }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_d1", content: "ok", is_error: false }] },
    },
    {
      type: "assistant",
      message: {
        id: "d2",
        content: [{
          type: "tool_use",
          id: "tu_d2",
          name: "mcp__playwright-mcp__browser_navigate",
          input: { url: "https://github.com/foo" },
        }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_d2", content: "done", is_error: false }] },
    },
    {
      type: "assistant",
      message: {
        id: "d3",
        content: [{
          type: "tool_use",
          id: "tu_d3",
          name: "mcp__computer-mcp__type",
          input: { text: `login as ${PLAIN_SECRET}` },
        }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_d3", content: "ok", is_error: false }] },
    },
  ];
  const lines = [INIT, ...DESKTOP_CALLS, M6, RESULT].map((l) => JSON.stringify(l));
  const vm = new ScriptedVm([{ chunks: [lines.join("\n") + "\n"] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "drive the desktop", env: envWithSecrets, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);

  const computer = events.filter((e): e is Extract<TelemetryEvent, { type: "computer.action" }> => e.type === "computer.action");
  assert.equal(computer.length, 3);
  assert.deepEqual(computer[0], { type: "computer.action", action: "Clicking at (44, 66)", x: 44, y: 66 });
  assert.deepEqual(computer[1], {
    type: "computer.action",
    action: "Opening github.com",
    url: "https://github.com/foo",
  });
  assert.deepEqual(computer[2], {
    type: "computer.action",
    // The summary carries a character count, never typed content; the
    // structured `text` field keeps the (redacted) text for detail
    // surfaces. "login as [REDACTED]" is 18 chars.
    action: "Typing (18 chars)",
    text: "login as [REDACTED]",
  });

  // The tool.call event carries the deep-redacted input; no event leaks the
  // plain secret anywhere (summary or structured fields).
  const calls = events.filter((e): e is Extract<TelemetryEvent, { type: "tool.call" }> => e.type === "tool.call");
  const typeCall = calls.find((c) => c.name === "mcp__computer-mcp__type");
  assert.deepEqual((typeCall!.input as { text: string }).text, "login as [REDACTED]");
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes(PLAIN_SECRET), "computer action leaked the secret");
  }
});

test("keeps -p and places a dash-leading prompt after --", async () => {
  const prompt = "\n--danger\n";
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt, env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const cmd = vm.calls[0].cmd;
  assert.equal(cmd[0], "claude");
  assert.equal(cmd[1], "-p");
  assert.equal(cmd.at(-2), "--");
  assert.equal(cmd.at(-1), prompt);
  assert.ok(cmd.includes("--output-format"));
  assert.ok(cmd.includes("stream-json"));
  assert.ok(cmd.includes("--verbose"));
});

// --- Backgrounded Bash detection (r5: long work must stay watchable) ---

test("isBackgroundedCommand flags detached work and ignores foreground commands", () => {
  const backgrounded = [
    "for i in $(seq 1 200); do echo $i; sleep 1; done &",
    "sleep 60 &",
    "npm run dev &",
    "nohup python server.py > server.log 2>&1 &",
    "setsid ./daemon.sh",
    "cmd1 & cmd2",
    "tmux new-session -d -s work ./run.sh",
    "screen -dmS worker ./run.sh",
    "long-job.sh; disown %1",
  ];
  for (const command of backgrounded) {
    assert.ok(isBackgroundedCommand(command), `expected backgrounded: ${command}`);
  }

  const foreground = [
    "ls -la",
    "for i in $(seq 1 200); do echo $i; sleep 1; done",
    "npm test && npm run build",
    "cmd 2>&1 | tee out.log",
    "cmd &> out.log",
    "echo hello && echo world",
    "git push",
    "",
    "   ",
  ];
  for (const command of foreground) {
    assert.ok(!isBackgroundedCommand(command), `expected foreground: ${command}`);
  }
});

test("emits tool.backgrounded for a detached Bash loop (the count-to-200 QA case)", async () => {
  const lines = [
    INIT,
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [{
          type: "tool_use",
          id: "toolu_bg",
          name: "Bash",
          input: { command: "for i in $(seq 1 200); do echo $i; sleep 1; done &" },
        }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "", is_error: false }],
      },
    },
    {
      type: "assistant",
      message: { id: "m2", content: [{ type: "text", text: "It'll take about 3 minutes." }] },
    },
    {
      type: "result",
      subtype: "success",
      duration_ms: 500,
      num_turns: 2,
      result: "It'll take about 3 minutes.",
      session_id: "sess_bg",
      total_cost_usd: 0.001,
    },
  ].map((l) => JSON.stringify(l));
  const vm = new ScriptedVm([{ chunks: [lines.join("\n") + "\n"] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "Count from 1 to 200 slowly", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const flagged = events.filter((e): e is Extract<TelemetryEvent, { type: "tool.backgrounded" }> => e.type === "tool.backgrounded");
  assert.equal(flagged.length, 1, "one backgrounded warning");
  assert.equal(flagged[0].name, "Bash");
  assert.ok(flagged[0].command.includes("seq 1 200"), "warning names the command");
  assert.ok(flagged[0].hint.length > 0, "warning carries guidance");
});

test("does not emit tool.backgrounded for a foreground Bash loop", async () => {
  const lines = [
    INIT,
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [{
          type: "tool_use",
          id: "toolu_fg",
          name: "Bash",
          input: { command: "for i in $(seq 1 200); do echo $i; sleep 1; done" },
        }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "1\n2\n3", is_error: false }],
      },
    },
    {
      type: "result",
      subtype: "success",
      duration_ms: 200000,
      num_turns: 1,
      result: "Done.",
      session_id: "sess_fg",
      total_cost_usd: 0.002,
    },
  ].map((l) => JSON.stringify(l));
  const vm = new ScriptedVm([{ chunks: [lines.join("\n") + "\n"] }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "Count from 1 to 200 slowly", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  assert.equal(events.filter((e) => e.type === "tool.backgrounded").length, 0);
});

// --- s5: exit 137 + misleading unrecognized_model ---

const UNRECOGNIZED_MODEL_STDERR =
  '[claude-code:unrecognized_model] {"model":"clarke-1.0","error":"model not recognized"}';

test("filters the benign unrecognized_model warning from a signal-kill error", async () => {
  const vm = new ScriptedVm([
    {
      chunks: FIXTURE_LINES.slice(0, 3).map((l) => l + "\n"), // init + text + tool call, then killed
      err: `${UNRECOGNIZED_MODEL_STDERR}\n`,
      exitCode: 137,
    },
  ]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 137);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /killed.*137.*SIGKILL/i);
  assert.match(errors[0].message, /timeout|cancellation|background child/i);
  assert.ok(!errors[0].message.includes("unrecognized_model"), "benign warning must not surface as the error");
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("marks a run finished with cost when the result arrived before a 137 reap", async () => {
  // The QA case: the agent answered, then a backgrounded bash loop kept stdout
  // open and the process group was reaped with SIGKILL ~100s later.
  const vm = new ScriptedVm([{ chunks: [FIXTURE], err: `${UNRECOGNIZED_MODEL_STDERR}\n`, exitCode: 137 }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const finished = events.filter((e) => e.type === "run.finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].costUsd, 0.021);
  assert.equal(finished[0].sessionId, "sess_demo_1");
  assert.equal(events.filter((e) => e.type === "run.error").length, 0);
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes("unrecognized_model"), "benign warning must not appear anywhere");
  }
});

test("reports a SIGTERM kill with a clear reason, not a bare exit code", async () => {
  const vm = new ScriptedVm([
    {
      chunks: FIXTURE_LINES.slice(0, 2).map((l) => l + "\n"),
      err: "Terminated\n",
      exitCode: 143,
    },
  ]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 143);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /killed.*143.*SIGTERM/i);
  assert.match(errors[0].message, /timeout|cancellation|background child/i);
});

test("reports an OOM kill when stderr says out of memory", async () => {
  const vm = new ScriptedVm([
    {
      chunks: FIXTURE_LINES.slice(0, 2).map((l) => l + "\n"),
      err: "Out of memory: Killed process 1234 (claude)\n",
      exitCode: 137,
    },
  ]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /137.*SIGKILL/i);
  assert.match(errors[0].message, /out of memory/i);
});

test("a stream-json error event holding only the benign warning is not surfaced", async () => {
  const ERROR_LINE = JSON.stringify({ type: "error", message: UNRECOGNIZED_MODEL_STDERR });
  const vm = new ScriptedVm([
    {
      chunks: [FIXTURE_LINES[0] + "\n", ERROR_LINE + "\n"],
      err: "Error: something real broke",
      exitCode: 1,
    },
  ]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 1);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exited with code 1: Error: something real broke/);
  assert.ok(!errors[0].message.includes("unrecognized_model"));
});

test("a benign-only error leaves no misleading detail on a nonzero exit", async () => {
  const ERROR_LINE = JSON.stringify({ type: "error", message: UNRECOGNIZED_MODEL_STDERR });
  const vm = new ScriptedVm([{ chunks: [FIXTURE_LINES[0] + "\n", ERROR_LINE + "\n"], exitCode: 1 }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "claude exited with code 1");
});

test("an error result does not turn a nonzero exit into a finish", async () => {
  const ERROR_RESULT = JSON.stringify({ ...RESULT, subtype: "error_max_turns", is_error: true });
  const vm = new ScriptedVm([{ chunks: [`${FIXTURE_LINES[0]}\n${ERROR_RESULT}\n`], exitCode: 1 }]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 1);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exited with code 1/);
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("an exec failure after the result still finishes the run with cost", async () => {
  // The max-duration quota rejects (throwing) while a background child holds
  // stdout open — if the result event already arrived, that is a finish.
  const throwingVm: VmExec = {
    async exec(_cmd, opts) {
      opts?.onStdout?.(FIXTURE);
      throw new Error("Exec exceeded max duration of 300000ms.");
    },
  };
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm: throwingVm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  const finished = events.filter((e) => e.type === "run.finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].costUsd, 0.021);
  assert.equal(events.filter((e) => e.type === "run.error").length, 0);
});

test("an exec failure without a result still reports the error", async () => {
  const throwingVm: VmExec = {
    async exec(_cmd, opts) {
      opts?.onStdout?.(FIXTURE_LINES[0] + "\n");
      throw new Error("boom");
    },
  };
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm: throwingVm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, -1);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /boom/);
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("isSignalKillExitCode classifies exits", () => {
  assert.equal(isSignalKillExitCode(137), true);
  assert.equal(isSignalKillExitCode(143), true);
  assert.equal(isSignalKillExitCode(130), true);
  assert.equal(isSignalKillExitCode(1), false);
  assert.equal(isSignalKillExitCode(0), false);
  assert.equal(isSignalKillExitCode(128), false);
  assert.equal(isSignalKillExitCode(-1), false);
});

// ---- System-1 wiring ----

const SYSTEM_ONE_BASE = {
  prompt: "Inspect repo",
  agentCard: "card",
  memoryContext: "memory",
  sessionId: "sess_resume_x",
  model: "claude-sonnet-5-5",
  env: envWithSecrets,
};

async function runSystemOne(runner: ClaudeCodeRunner, request: Record<string, unknown> = {}) {
  const vm = new ScriptedVm([{ chunks: [FIXTURE] }]);
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run({ ...SYSTEM_ONE_BASE, ...request, vm }, (e) => events.push(e));
  return { vm, events, outcome };
}

test("System-1 off: argv and events are byte-identical to today", async () => {
  const plain = await runSystemOne(new ClaudeCodeRunner());
  const disabled = await runSystemOne(new ClaudeCodeRunner({ systemOne: { settings: { enabled: false } } }));
  assert.equal(disabled.outcome.exitCode, 0);
  assert.deepEqual(disabled.vm.calls[0].cmd, plain.vm.calls[0].cmd, "argv is unchanged");
  // Wall-clock fields differ between two real runs by a millisecond; strip
  // only those, so any other event — including System-1 telemetry — differs.
  const withoutWallClock = (events: TelemetryEvent[]) =>
    events.map((event) => {
      const copy = { ...(event as unknown as Record<string, unknown>) };
      delete copy.startedAt;
      delete copy.finishedAt;
      return copy;
    });
  assert.deepEqual(withoutWallClock(disabled.events), withoutWallClock(plain.events), "no System-1 telemetry leaks into the run");
});

test("System-1 on + a denying gate pauses visibly through the approval flow", async () => {
  const approvals: Array<{ toolName: string; reason: string }> = [];
  const { events, outcome } = await runSystemOne(
    new ClaudeCodeRunner({
      systemOne: { settings: { enabled: true, gates: { guardrail: true } }, scorer: { ...localScorer, destructive: () => 0.99 } },
    }),
    {
      approvalGateway: (request) => {
        approvals.push({ toolName: request.toolName, reason: request.reason });
        return { id: `appr_${approvals.length}`, verdict: Promise.resolve("approved" as const) };
      },
    },
  );
  assert.equal(outcome.exitCode, 0, "an approved System-1 pause does not halt the run");
  assert.ok(approvals.length > 0, "the denying gate created an approval");
  assert.ok(approvals.every((a) => a.toolName === "Bash"), "the flagged calls are the Bash ones");
  assert.match(approvals[0].reason, /System-1 flags this command/);
  const required = events.filter((e) => e.type === "approval.required");
  assert.equal(required.length, approvals.length, "each pause is visible on the stream");
  assert.equal(events.some((e) => e.type === "tool.blocked"), false, "a deny is never a silent drop");
});

test("System-1 on + a throwing gate lets the call proceed (fail-open)", async () => {
  const { events, outcome } = await runSystemOne(
    new ClaudeCodeRunner({
      systemOne: {
        settings: { enabled: true, gates: { guardrail: true } },
        scorer: { ...localScorer, destructive: () => { throw new Error("gate down"); } },
      },
    }),
  );
  assert.equal(outcome.exitCode, 0);
  assert.equal(events.some((e) => e.type === "approval.required"), false, "no pause");
  assert.equal(events.some((e) => e.type === "tool.blocked"), false, "no halt");
  assert.ok(events.some((e) => e.type === "tool.result"), "the run carried on to tool results");
});

// ---- Decision Brain wiring ----

const BRAIN_INIT = {
  type: "system",
  subtype: "init",
  cwd: "/home/user",
  session_id: "sess_brain_1",
  model: "claude-sonnet-5-5",
};

const BRAIN_RESULT = {
  type: "result",
  subtype: "success",
  duration_ms: 100,
  num_turns: 1,
  result: "Done.",
  session_id: "sess_brain_1",
  cost_usd: 0.001,
};

function brainFixture(toolUse: Record<string, unknown>): string {
  const call = {
    type: "assistant",
    message: { id: "b1", content: [{ type: "tool_use", id: "toolu_b1", ...toolUse }] },
  };
  return [BRAIN_INIT, call, BRAIN_RESULT].map((l) => JSON.stringify(l)).join("\n") + "\n";
}

async function runBrain(runner: ClaudeCodeRunner, request: Record<string, unknown> = {}) {
  const { fixture, ...rest } = request;
  const vm = new ScriptedVm([{ chunks: [fixture as string] }]);
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "Inspect repo", env: envWithSecrets, ...rest, vm },
    (e) => events.push(e),
  );
  return { vm, events, outcome };
}

test("Brain on + heuristic: a relative rm -rf halts with the high-stakes reason", async () => {
  // The risk gate only asks for absolute/home/wildcard deletion targets;
  // a relative recursive delete classifies allow. The Brain's destructive
  // patterns catch it. No approval gateway → halt, never silent.
  const { events, outcome } = await runBrain(
    new ClaudeCodeRunner({ decisionBrain: { settings: { enabled: true } } }),
    {
      fixture: brainFixture({ name: "Bash", input: { command: "rm -rf build" } }),
    },
  );
  assert.equal(outcome.exitCode, 0);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Halted by harness risk policy: high-stakes:destructive-pattern/);
  assert.ok(events.some((e) => e.type === "tool.blocked"), "halt is visible on the stream");
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("Brain on + stub router retry: halts with the distinct retry marker", async () => {
  const retryRouter: DecisionRouter = {
    decide: async () => ({ decision: "retry", confidence: 0.8, reason: "last step failed", escalated: false }),
  };
  const { events } = await runBrain(
    new ClaudeCodeRunner({
      decisionBrain: { settings: { enabled: true }, router: retryRouter },
    }),
    { fixture: brainFixture({ name: "Bash", input: { command: "ls -la" } }) },
  );
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /decision brain requested retry: last step failed/);
});

test("Brain on + stub router ask: an approving gateway lets the run finish", async () => {
  const askRouter: DecisionRouter = {
    decide: async () => ({ decision: "ask", confidence: 1, reason: "needs a human", escalated: false }),
  };
  const approvals: string[] = [];
  const { events, outcome } = await runBrain(
    new ClaudeCodeRunner({
      decisionBrain: { settings: { enabled: true }, router: askRouter },
    }),
    {
      fixture: brainFixture({ name: "Bash", input: { command: "ls -la" } }),
      approvalGateway: (request: { toolName: string }) => {
        approvals.push(request.toolName);
        return { id: `appr_${approvals.length}`, verdict: Promise.resolve("approved" as const) };
      },
    },
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(approvals, ["Bash"]);
  assert.ok(events.some((e) => e.type === "approval.required"), "the pause is visible");
  assert.equal(events.some((e) => e.type === "run.error"), false);
});

test("Brain off: argv and events are byte-identical to today", async () => {
  const plain = await runSystemOne(new ClaudeCodeRunner());
  const disabled = await runSystemOne(
    new ClaudeCodeRunner({ decisionBrain: { settings: { enabled: false } } }),
  );
  assert.equal(disabled.outcome.exitCode, 0);
  assert.deepEqual(disabled.vm.calls[0].cmd, plain.vm.calls[0].cmd, "argv is unchanged");
  const withoutWallClock = (events: TelemetryEvent[]) =>
    events.map((event) => {
      const copy = { ...(event as unknown as Record<string, unknown>) };
      delete copy.startedAt;
      delete copy.finishedAt;
      return copy;
    });
  assert.deepEqual(withoutWallClock(disabled.events), withoutWallClock(plain.events), "no Brain telemetry leaks into the run");
});


test("redacts secret-shaped stderr detail on a nonzero exit", async () => {
  const secret = "plain-secret-value-123";
  const vm = new ScriptedVm([
    {
      chunks: [FIXTURE_LINES[0] + "\n"],
      err: `fatal: upstream rejected key ${secret}`,
      exitCode: 1,
    },
  ]);
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: { API_KEY: secret }, vm }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 1);
  const error = events.find((e) => e.type === "run.error") as Extract<TelemetryEvent, { type: "run.error" }>;
  assert.ok(error);
  assert.ok(!error.message.includes(secret), "stderrTail leaked a secret into run.error");
  assert.match(error.message, /\[REDACTED\]/);
});

test("a policy halt aborts the VM child immediately", async () => {
  const deny = JSON.stringify({
    type: "assistant",
    message: { id: "m_deny", content: [{ type: "tool_use", id: "toolu_deny", name: "Bash", input: { command: "echo ${API_KEY}" } }] },
  });
  let abortSeen = false;
  const vm: VmExec = {
    async exec(_cmd, opts) {
      opts?.onStdout?.(`${FIXTURE_LINES[0]}\n${deny}\n`);
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) {
          abortSeen = true;
          resolve();
          return;
        }
        opts?.signal?.addEventListener(
          "abort",
          () => {
            abortSeen = true;
            resolve();
          },
          { once: true },
        );
      });
      return { exitCode: 130 };
    },
  };
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  assert.equal(abortSeen, true, "the child was not aborted on halt");
  assert.equal(outcome.exitCode, 130);
  const error = events.find((e) => e.type === "run.error") as Extract<TelemetryEvent, { type: "run.error" }>;
  assert.match(error.message, /Halted by harness risk policy/);
});

test("a final newline-less line is flushed before the halt check", async () => {
  const deny = JSON.stringify({
    type: "assistant",
    message: { id: "m_deny", content: [{ type: "tool_use", id: "toolu_deny", name: "Bash", input: { command: "echo ${API_KEY}" } }] },
  });
  const vm: VmExec = {
    async exec(_cmd, opts) {
      // The denied call has no trailing newline: it only becomes visible on flush.
      opts?.onStdout?.(`${FIXTURE_LINES[0]}\n${deny}`);
      return { exitCode: 0 };
    },
  };
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  await runner.run({ prompt: "x", env: {}, vm }, (e) => events.push(e));

  const error = events.find((e) => e.type === "run.error") as Extract<TelemetryEvent, { type: "run.error" }>;
  assert.ok(error);
  assert.match(error.message, /Halted by harness risk policy/);
  assert.ok(!/no result event/i.test(error.message));
});

test("a role switch whose VM rejects on abort still returns roleSwitch", async () => {
  const switchCall = JSON.stringify({
    type: "assistant",
    message: {
      id: "m_switch",
      content: [{ type: "tool_use", id: "toolu_switch", name: "mcp__roles__set_role", input: { role_id: "debugger" } }],
    },
  });
  const nextPhase: RolePhase = {
    roleId: "debugger",
    roleName: "Debugger",
    allowedTools: ["Read"],
    mcpConfigPath: "/workspace/.swarm/mcp.json",
  };
  const vm: VmExec = {
    async exec(_cmd, opts) {
      opts?.onStdout?.(`${FIXTURE_LINES[0]}\n${switchCall}\n`);
      await new Promise<void>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted by role switch")), { once: true });
      });
      return { exitCode: 0 };
    },
  };
  const runner = new ClaudeCodeRunner();
  const events: TelemetryEvent[] = [];

  const outcome = await runner.run(
    {
      prompt: "switch",
      env: {},
      vm,
      rolePhase: { roleId: "main", roleName: "Main", allowedTools: ["Read"], mcpConfigPath: "/workspace/.swarm/mcp.json" },
      onRoleSwitch: async () => nextPhase,
    },
    (e) => events.push(e),
  );

  assert.equal(outcome.roleSwitch?.toRoleId, "debugger");
  assert.equal(events.some((e) => e.type === "run.error"), false);
  assert.equal(events.filter((e) => e.type === "role.changed").length, 1);
});
