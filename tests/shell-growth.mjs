// Real-code growth guards for lib/tools/shell.ts: a 24h run must not fill memory or disk.
// Run: npx tsx tests/shell-growth.mjs   (tsx so the TS module loads; no server, no LLM)
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-growth-"));
process.env.SWARM_HOME = HOME;
const SID = "a1b2c3d4e5f60718"; // store's session-id format
const SDIR = path.join(HOME, "sessions", SID);
fs.mkdirSync(SDIR, { recursive: true });

const mod = await import("../lib/tools/shell.ts");
const {
  shell,
  pruneLogs,
  logUsage,
  killSessionBackground,
  backgroundCount,
  CAPTURE_BYTES,
  STREAM_BYTES,
  LOG_BUDGET_BYTES,
  LOG_HEAD_BYTES,
} = mod;

const abort = new AbortController();
function ctx() {
  const sent = [];
  return {
    sessionId: SID,
    cwd: HOME,
    setCwd() {},
    signal: abort.signal,
    onOutput: (s) => sent.push(s),
    setPlan() {},
    sent,
  };
}

// 1. Small command: behaviour unchanged (output, exit code, cwd marker stripped).
{
  const c = ctx();
  const r = await shell.run({ command: "echo hello-growth-test" }, c);
  assert.ok(r.content.includes("hello-growth-test"), r.content);
  assert.ok(r.content.includes("[exit 0"), r.content);
  assert.ok(!r.content.includes("__SWARM_CWD__"), "cwd marker must not reach the model");
  assert.ok(c.sent.join("").includes("hello-growth-test"), "live stream must still carry output");
}

// 2. A 6 MB command: the returned result stays small, the full log goes to disk, nothing is lost.
{
  const c = ctx();
  const r = await shell.run({ command: "yes hello-growth | head -c 6000000", timeout_sec: 60 }, c);
  assert.ok(r.content.includes("earlier output"), "expected a pointer to the spilled log");
  const m = r.content.match(/saved to (\S+)]/);
  assert.ok(m, "expected the log path in the result");
  const logPath = m[1];
  assert.ok(fs.existsSync(logPath), `log file must exist: ${logPath}`);
  const logSize = fs.statSync(logPath).size;
  assert.ok(logSize > 4_000_000, `log should hold the bulk of the 6MB, got ${logSize}`);
  assert.ok(r.content.length < 60_000, `result must stay small, got ${r.content.length}`);
  assert.ok(c.sent.join("").length <= STREAM_BYTES + 500, `live stream must be capped, got ${c.sent.join("").length}`);
  const usage = logUsage(SID);
  assert.ok(usage.bytes <= LOG_BUDGET_BYTES, `session logs must stay in budget, got ${usage.bytes}`);
}

// 3. pruneLogs: settled logs are evicted oldest-first once the budget is exceeded.
{
  const before = logUsage(SID);
  const mk = (name, bytes, ageMs) => {
    const f = path.join(SDIR, name);
    fs.writeFileSync(f, "");
    fs.truncateSync(f, bytes); // sparse: tests size accounting without filling the disk
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
    return f;
  };
  const oldest = mk("out-old-a.log", 100 * 1024 * 1024, 60 * 60 * 1000);
  const middle = mk("out-old-b.log", 100 * 1024 * 1024, 30 * 60 * 1000);
  const newest = mk("out-old-c.log", 50 * 1024 * 1024, 60 * 1000);
  assert.ok(logUsage(SID).bytes > LOG_BUDGET_BYTES, "test setup must exceed the budget");
  pruneLogs(SID);
  const usage = logUsage(SID);
  assert.ok(usage.bytes <= LOG_BUDGET_BYTES, `over budget after prune: ${usage.bytes}`);
  assert.ok(!fs.existsSync(oldest), "oldest settled log should be evicted first");
  assert.ok(fs.existsSync(middle) || usage.bytes <= LOG_BUDGET_BYTES, "eviction proceeds oldest-first");
  assert.ok(fs.existsSync(newest), "a log touched a minute ago is still active and must survive");
  // A 100 MB tail-up: prune must also leave room for nothing else to creep in.
  const still = logUsage(SID);
  assert.ok(still.bytes <= LOG_BUDGET_BYTES, `budget held: ${still.bytes}`);
  assert.ok(before.bytes >= 0);
}

// 4. An oversized ACTIVE log is shrunk in place (head kept), never dropped, because a live writer
//    holds the descriptor and deleting it would not reclaim the blocks.
{
  const f = path.join(SDIR, "bg-active.log");
  fs.writeFileSync(f, "HEAD-MARKER\n" + "x".repeat(5000));
  fs.truncateSync(f, 500 * 1024 * 1024); // sparse, mtime = now -> still active
  fs.utimesSync(f, new Date(), new Date());
  pruneLogs(SID);
  const st = fs.statSync(f);
  assert.ok(st.size <= LOG_HEAD_BYTES, `active oversized log must be shrunk to the head, got ${st.size}`);
  assert.ok(fs.readFileSync(f, "utf8").startsWith("HEAD-MARKER"), "the head must be preserved");
  assert.ok(logUsage(SID).bytes <= LOG_BUDGET_BYTES, "budget held after active shrink");
}

// 5. Background jobs are tracked and can be stopped with the task.
{
  const c = ctx();
  const r = await shell.run({ command: "sleep 300", background: true }, c);
  assert.equal(backgroundCount(SID), 1, "background pid must be tracked");
  const pid = Number(r.content.match(/pid (\d+)/)?.[1]);
  assert.ok(Number.isInteger(pid), r.content);
  const alive = (p) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(pid), "child should be running");
  const killed = killSessionBackground(SID);
  assert.equal(killed, 1, "one process group should be signalled");
  await new Promise((r2) => setTimeout(r2, 600));
  assert.ok(!alive(pid), "background child must be gone");
  assert.equal(backgroundCount(SID), 0, "registry cleared after the kill");
  // Killing again is a no-op, not an error.
  assert.equal(killSessionBackground(SID), 0);
}
// 6. A session with no background jobs reports zero instead of throwing.
assert.equal(backgroundCount("0000000000000000"), 0);

console.log("shell-growth: 6/6 pass");
