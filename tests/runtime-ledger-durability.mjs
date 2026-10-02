// Durability + bounded growth for the run ledger's append-only step log.
//
// A 24h+ run records tens of thousands of steps. The old design rewrote the whole ledger on
// every step (O(n^2) write amplification — measured 1.8 GB for 3k steps). This test locks in the
// new contract: appends are O(1), the file is compacted to a bounded number of recent steps, the
// steps survive a fresh process, and a legacy ledger with inline steps still loads.
//
// Run:  npx tsx tests/runtime-ledger-durability.mjs
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-ledger-"));
process.env.SWARM_HOME = home;

const rt = await import(path.join(root, "lib/runtime/index.ts"));
const { createTask, addStep, getLedger } = rt;

let failures = 0;
const check = (name, cond, extra = "") => {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${extra ? ` — ${extra}` : ""}`);
};

const STEP_KEEP = 5000;
const STEP_COMPACT_AT = STEP_KEEP + 2000;

const t = await createTask({ prompt: "long run", sessionId: undefined });
const ledgerDir = path.join(home, "runtime", "ledger");
const stepsFile = path.join(ledgerDir, `${t.id}.steps.ndjson`);

// ---- Appends are linear, not quadratic ----
const N = STEP_KEEP + STEP_COMPACT_AT + 500;
let appended = 0;
const origAppend = fs.appendFile;
const origWrite = fs.writeFileSync;
fs.appendFile = (file, data, opts) => {
  if (String(file).includes("ledger")) appended += Buffer.byteLength(String(data));
  return origAppend.call(fs, file, data, opts);
};
fs.writeFileSync = (file, data, opts) => {
  if (String(file).includes("ledger")) appended += Buffer.byteLength(String(data));
  return origWrite.call(fs, file, data, opts);
};
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  await addStep(t.id, "run1", { kind: "tool", label: "bash", detail: "x".repeat(200), ok: true });
}
const ms = Date.now() - t0;
fs.appendFile = origAppend;
fs.writeFileSync = origWrite;

const perStep = appended / N;
// Linear: total bytes ~= N * one step line (~280 B). Quadratic would be ~N^2/2 * line.
check(
  "writes are O(n), not O(n^2)",
  perStep < 600,
  `${(appended / 1048576).toFixed(1)} MB for ${N} steps (${perStep.toFixed(0)} B/step; the old path wrote ~${((N * N * 140) / 1048576).toFixed(0)} MB)`,
);
check("a long append run is fast", ms < 20_000, `${ms} ms for ${N} steps`);

const lines = () => fs.readFileSync(stepsFile, "utf8").split("\n").filter(Boolean).length;
const onDiskKB = () => +(fs.statSync(stepsFile).size / 1024).toFixed(1);

// ---- The file is compacted to a bound ----
check(
  "steps log is compacted to a bounded size",
  lines() <= STEP_COMPACT_AT,
  `${lines()} lines, ${onDiskKB()} KB (cap ${STEP_COMPACT_AT}, served ${STEP_KEEP})`,
);
check("compaction actually dropped old lines", lines() < N, `${lines()} lines on disk < ${N} appended`);
check("the most recent step is kept", getLedger(t.id).steps.at(-1)?.detail === "x".repeat(200));
check("the served step list is bounded", getLedger(t.id).steps.length <= STEP_KEEP, `${getLedger(t.id).steps.length}`);

// ---- Steps survive a fresh process ----
check("runs metadata lives in the ledger JSON, steps in the ndjson", () => {
  assert.ok(fs.existsSync(path.join(ledgerDir, `${t.id}.json`)), "ledger json exists");
  assert.ok(fs.existsSync(stepsFile), "steps ndjson exists");
  const json = JSON.parse(fs.readFileSync(path.join(ledgerDir, `${t.id}.json`), "utf8"));
  assert.ok(!Array.isArray(json.steps) || json.steps.length === 0, "steps are not duplicated into the JSON");
  return true;
});

const probe = path.join(home, "probe.mjs");
fs.writeFileSync(
  probe,
  `const rt = await import(${JSON.stringify(path.join(root, "lib/runtime/index.ts"))});\n` +
    `const l = rt.getLedger(${JSON.stringify(t.id)});\n` +
    `process.stdout.write(JSON.stringify({ steps: l.steps.length, last: l.steps.at(-1)?.label }));\n`,
);
const freshOut = execFileSync("npx", ["tsx", probe], {
  env: { ...process.env, SWARM_HOME: home },
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
});
const fresh = JSON.parse(freshOut.trim().split("\n").pop());
check("a fresh process reads the steps back", fresh.steps > 0 && fresh.steps <= STEP_KEEP, JSON.stringify(fresh));

// ---- Legacy ledgers with inline steps still load ----
const legacyId = "legacy00000000";
fs.mkdirSync(ledgerDir, { recursive: true });
fs.writeFileSync(
  path.join(ledgerDir, `${legacyId}.json`),
  JSON.stringify({
    runs: [],
    steps: [{ id: "s1", taskId: legacyId, runId: "r", ts: 1, kind: "checkpoint", label: "old inline step" }],
  }),
);
const legacy = getLedger(legacyId);
check("a legacy ledger with inline steps still loads them", legacy.steps.some((s) => s.label === "old inline step"), `${legacy.steps.length} steps`);

// ---- Run records are capped too (a task that restarts many times must not grow forever) ----
const { startRun } = rt;
for (let i = 0; i < 260; i++) await startRun(t.id, "sess", i + 1);
const runs = getLedger(t.id).runs;
check("run history is capped", runs.length <= 200, `${runs.length} runs kept`);

console.log(failures === 0 ? "\nLEDGER DURABILITY PASS" : `\nLEDGER DURABILITY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);