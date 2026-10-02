// Router bench durability: a provider that is out of credits must stay benched across a restart.
//
// The bug this guards: bench/streak state lived only in process memory, so after a restart the
// router retried a provider we already knew was exhausted - wasteful and, on a 24h run, a way to
// hammer a dead key forever. The fix persists the deadline in LearnedLimits.benchUntil.
//
// Run:  ./node_modules/.bin/tsx tests/router.bench.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rb-"));
process.env.SWARM_HOME = home;
process.env.SWARM_STALL_MS = "4000";

let failures = 0;
const check = (name, cond, extra = "") => {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${extra ? ` — ${extra}` : ""}`);
};

// ---- A mock provider that is always out of credits ----
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  res.writeHead(402, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const store = await import(path.join(root, "lib/store.ts"));
store.saveProviders([
  { id: "p1", kind: "openai", label: "Exhausted", apiKey: "sk-x", baseUrl, model: "gpt-4o-mini", enabled: true },
]);

const { routeTurn } = await import(path.join(root, "lib/router.ts"));

console.log(`router bench e2e — SWARM_HOME=${home}\n`);

// ---- 1. First exhausted response benches the provider AND persists the deadline ----
console.log("1. an out-of-credits provider is benched and the deadline is persisted");
const req = { messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }], system: "", tools: [], signal: new AbortController().signal };
const notes = [];
// Don't let the router loop forever: abort after the first bench window starts.
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 1500);
try {
  await routeTurn({ ...req, signal: ac.signal }, { onThinking() {}, onText() {}, onToolStart() {}, onToolInput() {}, onBlockEnd() {} }, { onNotice: (_l, t) => notes.push(t), onAttempt() {} });
} catch {
  /* expected: aborted while waiting out the bench */
} finally {
  clearTimeout(timer);
}

const persisted = store.getLimits()["p1"];
const now = Date.now();
check("benchUntil persisted in the future", typeof persisted?.benchUntil === "number" && persisted.benchUntil > now, persisted?.benchUntil ? `${Math.round((persisted.benchUntil - now) / 1000)}s ahead` : "missing");
check("exhausted notice surfaced to the user", notes.some((n) => /out of credits or quota/i.test(n)), notes[0]?.slice(0, 80));
check("provider was actually attempted at least once", hits >= 1, `${hits} requests`);

// ---- 2. Restart: a fresh process must still treat the provider as benched ----
console.log("\n2. a fresh process (restart) still treats the provider as benched");
// Simulate restart by spawning a clean node process that only loads the store and reads limits.
const { execFileSync } = await import("node:child_process");
const script = `
  const path = require("node:path");
  const root = ${JSON.stringify(root)};
  process.env.SWARM_HOME = ${JSON.stringify(home)};
  import("file://" + path.join(root, "lib/store.ts")).then((s) => {
    const l = s.getLimits()["p1"];
    const ahead = l && l.benchUntil && l.benchUntil > Date.now();
    process.stdout.write(ahead ? "BENCHED" : "FREE");
  });
`;
const out = execFileSync(path.join(root, "node_modules/.bin/tsx"), ["-e", script], { encoding: "utf8" }).trim();
check("restarted process reads the persisted bench", out === "BENCHED", out);

server.close();
console.log(`\n${failures === 0 ? "ROUTER BENCH PASS" : `ROUTER BENCH FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);