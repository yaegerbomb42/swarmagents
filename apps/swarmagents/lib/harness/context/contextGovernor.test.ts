/**
 * Tests for the L1 context packer (lib/harness/context/contextGovernor.ts).
 *
 * The acceptance test packs a multi-file task over several turns and checks
 * every turn stays under 8,192 tokens with the four-section budget ledger
 * (ledger ~600 / skeleton ~1,500 / working set ~3,500 / reserve ~2,400)
 * printed in the log.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../../codebase/tokens";
import type { RunRequest } from "../types";
import type { SourceFile } from "./astSlicer";
import {
  ContextGovernor,
  DEFAULT_CONTEXT_PACKER,
  DEFAULT_L1_BUDGET,
  fitText,
  MAX_INPUT_TOKENS,
  MAX_TOTAL_TOKENS,
  resolveBudget,
  resolveContextPacker,
  StateLedger,
  systemExtrasFrom,
  toPackedRunRequest,
} from "./contextGovernor";

function bigFile(path: string, fns: number): SourceFile {
  const lines: string[] = [`// ${path}`, 'import { helper } from "./helper";', ""];
  for (let i = 0; i < fns; i++) {
    lines.push(`export function ${path.replace(/\W/g, "_")}_fn${i}(input: number): number {`);
    for (let j = 0; j < 6; j++) lines.push(`  const v${j} = helper(input, ${j}) + ${i}; // step ${j}`);
    lines.push("  return v5;", "}", "");
  }
  return { path, content: lines.join("\n") };
}

const LOG_RE =
  /^context-packer\[l1\] turn=(\d+) budget=8192 ledger=(\d+)\/600 skeleton=(\d+)\/1500 working=(\d+)\/(\d+)(?: \(\+(\d+) rollover\))? reserve=(\d+)\/2400 \(system (\d+), output 992\) total=(\d+)\/8192(?: omitted=\d+)?$/;

test("default budget matches the spec and leaves headroom under 8,192", () => {
  assert.deepEqual({ ...DEFAULT_L1_BUDGET }, {
    total: 8192,
    ledger: 600,
    skeleton: 1500,
    workingSet: 3500,
    reserve: 2400,
    outputBuffer: 992,
  });
  const sum = DEFAULT_L1_BUDGET.ledger + DEFAULT_L1_BUDGET.skeleton + DEFAULT_L1_BUDGET.workingSet + DEFAULT_L1_BUDGET.reserve;
  assert.ok(sum <= MAX_TOTAL_TOKENS);
  assert.throws(() => resolveBudget({ workingSet: 6000 }), /exceed the turn total/);
  assert.throws(() => resolveBudget({ ledger: -1 }), /non-negative/);
  assert.throws(() => resolveBudget({ outputBuffer: 3000 }), /fit inside reserve/);
});

test("acceptance: a multi-file task stays under 8,192 tokens every turn with the budget in the log", () => {
  const logs: string[] = [];
  const governor = new ContextGovernor({ log: (line) => logs.push(line) });

  // Eight files in scope (~10k lines, far over budget unpacked); three being edited.
  const files = Array.from({ length: 8 }, (_, i) => bigFile(`src/mod${i}.ts`, 140));
  const unpacked = files.reduce((n, f) => n + estimateTokens(f.content), 0);
  assert.ok(unpacked > 8 * MAX_TOTAL_TOKENS, `fixture should be big (got ${unpacked})`);

  const ledger = new StateLedger("Rename helper() to computeStep() across src/ and keep every test green.", {
    constraints: ["do not touch lib/harness/runner.ts", "keep imports extensionless"],
  });

  for (let turn = 1; turn <= 6; turn++) {
    const packed = governor.pack({
      turn,
      ledger,
      skeletonFiles: files,
      workingSet: [
        { ...files[turn % 8], focus: [{ start: 200 + turn * 10, end: 210 + turn * 10 }], priority: 2 },
        { ...files[(turn + 1) % 8], focus: [{ start: 400, end: 405 }], priority: 1 },
        files[(turn + 2) % 8],
      ],
      systemExtras: ["You are the coder role.", "Long-term memory: the repo uses node:test."],
    });

    const u = packed.usage;
    const input = estimateTokens(packed.systemPrompt) + estimateTokens(packed.prompt);
    assert.equal(u.input, input, "usage.input must be measured, not assumed");
    assert.ok(u.total <= MAX_TOTAL_TOKENS, `turn ${turn}: total ${u.total} > 8192`);
    assert.ok(u.input <= MAX_INPUT_TOKENS, `turn ${turn}: input ${u.input} > ${MAX_INPUT_TOKENS}`);
    assert.ok(u.ledger.used <= 600, `ledger ${u.ledger.used}`);
    assert.ok(u.skeleton.used <= 1500, `skeleton ${u.skeleton.used}`);
    assert.ok(u.workingSet.used <= u.workingSet.cap, `working ${u.workingSet.used}/${u.workingSet.cap}`);
    assert.ok(u.reserve.used <= 2400 && u.reserve.output === 992);
    // Heavy pressure: the skeleton and working set are both nearly full.
    assert.ok(u.skeleton.used > 1000, `skeleton should be well used (${u.skeleton.used})`);
    assert.ok(u.workingSet.used > 3000, `working set should be well used (${u.workingSet.used})`);

    // The prompt contains every section and the focused lines of the top file.
    assert.match(packed.prompt, new RegExp(`## State ledger \\(turn ${turn}\\)`));
    assert.match(packed.prompt, /## Code skeleton/);
    assert.match(packed.prompt, /## Working set/);
    assert.match(packed.prompt, new RegExp(`\\n${205 + turn * 10} \\| `));
    assert.match(packed.systemPrompt, /You are the coder role\./);

    assert.equal(logs[turn - 1], packed.logLine);
    const m = LOG_RE.exec(packed.logLine);
    assert.ok(m, `log line has the four-section budget: ${packed.logLine}`);
    assert.equal(Number(m[1]), turn);
    assert.equal(Number(m[9]), u.total);

    ledger.recordStep(turn, `edited ${files[turn % 8].path}: renamed ${30 + turn} call sites, tests pass`);
    if (turn === 3) ledger.setError("TypeError: computeStep is not a function\n    at src/mod4.ts:212:7\n".repeat(30));
    if (turn === 4) ledger.setError(undefined);
  }
  // Visible budget ledger in the test output.
  for (const line of logs) console.log(line);
  assert.equal(logs.length, 6);
});

test("unused ledger/skeleton budget rolls into the working set, never into the output buffer", () => {
  const governor = new ContextGovernor();
  const file = bigFile("src/only.ts", 400);
  const packed = governor.pack({ turn: 1, ledger: new StateLedger("small"), skeletonFiles: [], workingSet: [file] });
  const u = packed.usage;
  assert.ok(u.workingSet.rollover > 1500, `rollover ${u.workingSet.rollover}`);
  assert.ok(u.workingSet.used > 3500, `working set uses rollover (${u.workingSet.used})`);
  assert.ok(u.total <= 8192 && u.input <= MAX_INPUT_TOKENS);
  assert.equal(u.reserve.output, 992);
  assert.match(packed.logLine, /\(\+\d+ rollover\)/);
});

test("files that do not fit are listed so the agent can ask for them", () => {
  const governor = new ContextGovernor();
  const many = Array.from({ length: 6 }, (_, i) => bigFile(`src/w${i}.ts`, 200));
  const packed = governor.pack({ turn: 1, ledger: new StateLedger("g"), skeletonFiles: [], workingSet: many });
  assert.ok(packed.omitted.length > 0);
  assert.match(packed.prompt, /Not shown this turn \(ask for a path and line range\): .*src\/w5\.ts/);
  assert.match(packed.logLine, /omitted=\d+$/);
  assert.ok(packed.usage.total <= 8192);
});

test("a huge system extra is cut to the reserve, never squeezing the output buffer", () => {
  const governor = new ContextGovernor();
  const packed = governor.pack({
    turn: 1,
    ledger: new StateLedger("g"),
    skeletonFiles: [],
    workingSet: [],
    systemExtras: ["agent card ".repeat(5000)],
  });
  assert.ok(packed.usage.reserve.system <= 2400 - 992);
  assert.ok(packed.usage.reserve.used <= 2400);
  assert.match(packed.systemPrompt, /^L1 context mode/);
});

test("StateLedger keeps goal, last error tail and newest steps within its cap", () => {
  const ledger = new StateLedger("Fix the flaky upload test", { constraints: ["no new deps"] });
  for (let t = 1; t <= 200; t++) ledger.recordStep(t, `tried approach ${t} and observed result ${t}`);
  ledger.setError("noise line\n".repeat(400) + "ROOT CAUSE: ENOENT /tmp/upload");
  const text = ledger.render(201, 600);
  assert.ok(estimateTokens(text) <= 600, `ledger ${estimateTokens(text)}`);
  assert.match(text, /Goal: Fix the flaky upload test/);
  assert.match(text, /ROOT CAUSE: ENOENT/);
  assert.match(text, /constraint: no new deps/);
  assert.match(text, /t200: tried approach 200/);
  assert.match(text, /\(\d+ earlier steps elided\)/);
  assert.doesNotMatch(text, /t1: tried/);

  const round = StateLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.equal(round.render(201, 600), text);
});

test("fitText keeps head, tail or both ends and always fits", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  for (const keep of ["head", "tail", "middle"] as const) {
    const out = fitText(text, 100, keep);
    assert.ok(estimateTokens(out) <= 100, `${keep}: ${estimateTokens(out)}`);
    assert.match(out, /snipped for L1 budget/);
  }
  assert.match(fitText(text, 100, "head"), /^line 0\n/);
  assert.match(fitText(text, 100, "tail"), /line 499$/);
  const mid = fitText(text, 100, "middle");
  assert.match(mid, /^line 0/);
  assert.match(mid, /line 499$/);
  assert.equal(fitText("short", 100), "short");
  assert.equal(fitText(text, 0), "");
});

test("selection: ClaudeCodeRunner behaviour is the default; l1 is opt-in per run or role", () => {
  assert.equal(DEFAULT_CONTEXT_PACKER, "claude-code");
  assert.equal(resolveContextPacker(), "claude-code");
  assert.equal(resolveContextPacker({ roleId: "coder" }), "claude-code");
  assert.equal(resolveContextPacker({ roleId: "coder", roles: { coder: "l1" } }), "l1");
  assert.equal(resolveContextPacker({ run: "claude-code", roleId: "coder", roles: { coder: "l1" } }), "claude-code");
  assert.equal(resolveContextPacker({ run: "l1" }), "l1");
  assert.equal(resolveContextPacker({ run: "mini-forced", roleId: "x", roles: { x: 42 } }), "claude-code");
});

test("toPackedRunRequest swaps in the packed turn, drops --resume and keeps the role's tools", () => {
  const request: RunRequest = {
    prompt: "original",
    agentCard: "card",
    memoryContext: "memory",
    sessionId: "sess-1",
    model: "m",
    env: { SOME_KEY: "value-not-touched" },
    vm: { exec: async () => ({ exitCode: 0 }) },
    rolePhase: { roleId: "coder", allowedTools: ["Read", "Edit"], mcpConfigPath: "/x.json", appendSystemPrompt: "role prompt" },
  };
  assert.deepEqual(systemExtrasFrom(request), ["card", "role prompt", "memory"]);

  const governor = new ContextGovernor();
  const packed = governor.pack({
    turn: 1,
    ledger: new StateLedger("goal"),
    skeletonFiles: [],
    workingSet: [],
    systemExtras: systemExtrasFrom(request),
  });
  const out = toPackedRunRequest(request, packed);
  assert.equal(out.prompt, packed.prompt);
  assert.equal(out.agentCard, packed.systemPrompt);
  assert.match(out.agentCard ?? "", /card[\s\S]*role prompt[\s\S]*memory/);
  assert.equal(out.memoryContext, undefined);
  assert.equal(out.sessionId, undefined);
  assert.deepEqual(out.rolePhase, { roleId: "coder", allowedTools: ["Read", "Edit"], mcpConfigPath: "/x.json", appendSystemPrompt: undefined });
  assert.equal(out.env, request.env);
  assert.equal(out.model, "m");
  // The original request is untouched.
  assert.equal(request.sessionId, "sess-1");
  assert.equal(request.rolePhase?.appendSystemPrompt, "role prompt");
});
