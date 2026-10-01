#!/usr/bin/env node
// End-to-end test: the real Next server + agent loop + adapters against the scripted mock LLM (tests/mock-llm.mjs)
// and a mock MCP server (tests/mock-mcp.mjs). No real provider, no network, isolated SWARM_HOME.
//
//   npm run test:e2e                     # starts `next dev` on 3781 (dist dir .next-e2e)
//   npm run test:e2e -- --prod           # `next build` + `next start` instead (slower, closest to production)
//   npm run test:e2e -- --url http://127.0.0.1:3781   # reuse a server you started yourself with SWARM_HOME set
//   npm run test:e2e -- --only tools,ratelimit        # subset of cases
//   E2E_PORT, MOCK_PORT override ports.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const PORT = Number(process.env.E2E_PORT || 3781);
const MOCK_PORT = Number(process.env.MOCK_PORT || 37901);
const ONLY = opt("--only")?.split(",");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-home-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-work-"));
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
let BASE = opt("--url") ?? `http://127.0.0.1:${PORT}`;
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

function start(cmd, argv, env, logFile) {
  const out = fs.openSync(logFile, "w");
  const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
  children.push(p);
  return p;
}

function cleanup() {
  for (const p of children) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function waitFor(url, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`${what} did not come up at ${url} within ${ms / 1000}s`);
}

async function api(method, p, body) {
  const r = await fetch(`${BASE}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json, text };
}

function assert(cond, msg, extra) {
  if (!cond) {
    const e = new Error(msg);
    e.extra = extra;
    throw e;
  }
}

// ---------- session driver: applies the SSE op stream exactly like the UI does ----------

async function runTask(text, { timeout = 60_000, onEvent, sessionId } = {}) {
  const sid = sessionId ?? (await api("POST", "/api/sessions")).json.session.id;
  const ctrl = new AbortController();
  const events = new Map();
  let running = false;
  let sawRunning = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = await fetch(`${BASE}/api/sessions/${sid}`, { signal: ctrl.signal, headers: { Accept: "text/event-stream" } });
  assert(res.ok, `SSE stream returned ${res.status}`);
  const baseline = new Set();
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const op = JSON.parse(line.slice(6));
          if (op.op === "snapshot") {
            for (const e of op.events) {
              events.set(e.id, e);
              baseline.add(e.id);
            }
            running = op.running;
          } else if (op.op === "add") {
            events.set(op.event.id, op.event);
            onEvent?.(op.event, events);
          } else if (op.op === "patch") {
            const e = events.get(op.id);
            if (e) {
              Object.assign(e, op.patch);
              if (op.append) e[op.append.field] = (e[op.append.field] ?? "") + op.append.value;
              onEvent?.(e, events);
            }
          } else if (op.op === "running") {
            running = op.running;
            if (running) sawRunning = true;
            else if (sawRunning) resolveDone();
          }
        }
      }
    } catch {}
  })();
  await sleep(150);
  const sent = await api("POST", `/api/sessions/${sid}`, { text });
  assert(sent.status === 200, `send returned ${sent.status}`);
  const timer = sleep(timeout).then(() => "timeout");
  const outcome = await Promise.race([done.then(() => "done"), timer]);
  await sleep(250);
  ctrl.abort();
  const fresh = [...events.values()].filter((e) => !baseline.has(e.id));
  if (outcome === "timeout") {
    const err = new Error(`task did not finish within ${timeout / 1000}s`);
    err.extra = summarize(fresh);
    throw err;
  }
  return { sid, events: fresh, all: [...events.values()] };
}

const texts = (evs) => evs.filter((e) => e.type === "text").map((e) => e.text).join("\n");
const tools = (evs) => evs.filter((e) => e.type === "tool");
const notices = (evs) => evs.filter((e) => e.type === "notice");
const summarize = (evs) => evs.map((e) => `${e.type}${e.name ? `:${e.name}` : ""}${e.status ? `(${e.status})` : ""} ${String(e.text ?? e.output ?? e.summary ?? "").slice(0, 120).replace(/\n/g, " ")}`).join("\n");

// ---------- cases ----------

const ctx = {};

/** Run fn with a fresh provider as the only enabled one, then restore the main mock provider. */
async function withScratchProvider(label, fn) {
  const r = await api("POST", "/api/connections", { type: "llm", preset: "custom", label, baseUrl: `${MOCK}/v1`, apiKey: "scratch-key", model: "mock" });
  const id = r.json.id;
  await api("POST", "/api/connections", { type: "llm", id: ctx.openaiId, enabled: false });
  const t0 = Date.now();
  try {
    return { ...(await fn()), ms: Date.now() - t0 };
  } finally {
    await api("DELETE", `/api/connections?type=llm&id=${id}`);
    await api("POST", "/api/connections", { type: "llm", id: ctx.openaiId, enabled: true });
  }
}

const cases = {
  async catalog() {
    const r = await api("GET", "/api/connections");
    assert(r.status === 200, `GET /api/connections ${r.status}`);
    const { llm, tool, mcp } = r.json.catalog;
    assert(llm.length >= 40 && tool.length >= 15 && mcp.length >= 15, `catalog too small: ${llm.length}/${tool.length}/${mcp.length}`);
    for (const id of ["openai", "anthropic", "gemini", "xai", "mistral", "groq", "cerebras", "together", "fireworks", "deepseek", "openrouter", "perplexity", "cohere", "azure", "bedrock", "ollama", "lmstudio", "vllm", "custom", "custom-anthropic"])
      assert(llm.some((p) => p.id === id), `missing LLM preset ${id}`);
    return `${llm.length} LLM presets, ${tool.length} tool keys, ${mcp.length} MCP servers`;
  },

  async page() {
    const r = await fetch(`${BASE}/`);
    const html = await r.text();
    assert(r.status === 200 && html.includes("<html"), `GET / returned ${r.status}`);
    return "app shell renders";
  },

  async connections() {
    // Validation errors are friendly 400s.
    let r = await api("POST", "/api/connections", { type: "llm", preset: "custom", apiKey: "x", model: "mock" });
    assert(r.status === 400 && /base URL/i.test(r.json.error), "custom endpoint without URL should 400", r.json);
    r = await api("POST", "/api/connections", { type: "llm", preset: "azure", apiKey: "x", model: "d" });
    assert(r.status === 400 && /resource/i.test(r.json.error), "azure without resource should ask for it", r.json);
    // Bad key: test reports a readable failure, not a crash.
    r = await api("POST", "/api/connections/test", { type: "llm", preset: "custom", baseUrl: `${MOCK}/v1`, apiKey: "bad-key", model: "mock" });
    assert(r.json.ok === false && /reject|401|key/i.test(r.json.message), "bad key should fail test", r.json);
    // Nothing listening: clear message.
    r = await api("POST", "/api/connections/test", { type: "llm", preset: "custom", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" });
    assert(r.json.ok === false && /listening|connect|refused|fetch/i.test(r.json.message), "dead port should fail clearly", r.json);
    // Good: OpenAI-compatible custom endpoint with a templated header.
    r = await api("POST", "/api/connections/test", { type: "llm", preset: "custom", baseUrl: `${MOCK}/v1`, apiKey: "e2e-key-openai-1234", model: "mock" });
    assert(r.json.ok && r.json.models.some((m) => m.id === "mock-tools"), "test should list mock models", r.json);
    r = await api("POST", "/api/connections", { type: "llm", preset: "custom", label: "Mock OpenAI", baseUrl: `${MOCK}/v1`, apiKey: "e2e-key-openai-1234", model: "mock", headers: { "X-Swarm-E2E": "hdr-{key}" } });
    assert(r.status === 200, `save llm ${r.status}`, r.json);
    ctx.openaiId = r.json.id;
    assert(!r.text.includes("e2e-key-openai-1234"), "API response leaked the key");
    const saved = r.json.connections.find((x) => x.id === ctx.openaiId);
    assert(saved.keyHint === "…1234" && saved.headers["X-Swarm-E2E"] === "hdr-{key}", "key hint / header template", saved);
    // Stored at 0600, key present on disk only.
    const st = fs.statSync(path.join(HOME, "settings.json"));
    assert((st.mode & 0o777) === 0o600, `settings.json mode ${(st.mode & 0o777).toString(8)}`);
    // Editing without a key keeps the key; test of a saved provider uses the stored key.
    r = await api("POST", "/api/connections", { type: "llm", id: ctx.openaiId, label: "Mock OpenAI", model: "mock" });
    assert(r.status === 200 && r.json.connections.find((x) => x.id === ctx.openaiId).keyHint === "…1234", "edit dropped the key", r.json);
    r = await api("POST", "/api/connections/test", { type: "llm", id: ctx.openaiId });
    assert(r.json.ok, "test by id should use stored key", r.json);
    // Legacy endpoint still works for old callers.
    r = await api("GET", "/api/providers");
    assert(r.json.providers.length === 1 && !r.text.includes("e2e-key-openai-1234"), "legacy /api/providers", r.json);
    // Tool key: custom with a test URL (mock /v1/models accepts any key except bad-key).
    r = await api("POST", "/api/connections/test", { type: "tool", preset: "custom-key", envVar: "MOCK_SERVICE_KEY", apiKey: "bad-key", testUrl: `${MOCK}/v1/models` });
    assert(r.json.ok === false, "bad tool key should fail", r.json);
    r = await api("POST", "/api/connections", { type: "tool", preset: "custom-key", envVar: "mock_service_key", apiKey: "tool-secret-5678", testUrl: `${MOCK}/v1/models` });
    assert(r.status === 200, "save tool key", r.json);
    const tk = r.json.connections.find((x) => x.type === "tool");
    assert(tk.envVar === "MOCK_SERVICE_KEY" && tk.keyHint === "…5678" && !r.text.includes("tool-secret-5678"), "tool key public shape", tk);
    r = await api("POST", "/api/connections/test", { type: "tool", id: tk.id });
    assert(r.json.ok, "tool key test by id", r.json);
    // Short secrets never come back, not even partially.
    r = await api("POST", "/api/connections", { type: "tool", preset: "custom-key", envVar: "SHORT_KEY", apiKey: "abcd" });
    const short = r.json.connections.find((x) => x.envVar === "SHORT_KEY");
    assert(short?.keyHint === "set" && !/abcd/.test(JSON.stringify(r.json.connections)), "short key must not be echoed", short);
    await api("DELETE", `/api/connections?type=tool&id=${short.id}`);
    // MCP stdio server: test lists its tools, save writes mcp.json in Claude's shape.
    const mcpDef = { type: "mcp", preset: "custom-stdio", label: "Mock MCP", command: process.execPath, args: [path.join(ROOT, "tests/mock-mcp.mjs")], env: { MOCK_MCP_SECRET: "mcp-secret-9999", MOCK_REF: "${MOCK_SERVICE_KEY}", SHORT_PIN: "s3cr3t" } };
    // A command that exits says why (its stderr), not just "Connection closed".
    r = await api("POST", "/api/connections/test", { type: "mcp", preset: "custom-stdio", command: process.execPath, args: [path.join(WORK, "missing-server.js")] });
    assert(r.json.ok === false && /exited.*(Cannot find module|MODULE_NOT_FOUND)/.test(r.json.message), "crashed MCP command should report its stderr", r.json);
    r = await api("POST", "/api/connections/test", mcpDef);
    assert(r.json.ok && r.json.tools.map((t) => t.name).join() === "echo,add", "MCP test should list echo,add", r.json);
    r = await api("POST", "/api/connections", mcpDef);
    assert(r.status === 200 && r.json.id === "mock-mcp", "save MCP", r.json);
    const mcpPub = r.json.connections.find((x) => x.id === "mock-mcp");
    assert(mcpPub.env.MOCK_MCP_SECRET.startsWith("••••") && !r.text.includes("mcp-secret-9999"), "MCP env must be masked", mcpPub);
    assert(mcpPub.env.SHORT_PIN === "••••" && !r.text.includes("s3cr3t") && mcpPub.env.MOCK_REF === "${MOCK_SERVICE_KEY}", "short env secrets masked, ${VAR} refs readable", mcpPub.env);
    const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, "mcp.json"), "utf8"));
    assert(onDisk.mcpServers["mock-mcp"].env.MOCK_MCP_SECRET === "mcp-secret-9999", "mcp.json keeps the real secret");
    // Editing with the masked value keeps the secret.
    r = await api("POST", "/api/connections", { type: "mcp", id: "mock-mcp", label: "Mock MCP", command: process.execPath, args: mcpDef.args, env: mcpPub.env });
    assert(JSON.parse(fs.readFileSync(path.join(HOME, "mcp.json"), "utf8")).mcpServers["mock-mcp"].env.MOCK_MCP_SECRET === "mcp-secret-9999", "masked edit lost the MCP secret");
    // Toggle + reorder.
    r = await api("POST", "/api/connections", { type: "tool", id: tk.id, enabled: false });
    assert(r.json.connections.find((x) => x.id === tk.id).enabled === false, "toggle tool off");
    await api("POST", "/api/connections", { type: "tool", id: tk.id, enabled: true });
    return "validation, test, save, masking, 0600, keep-key edits, legacy route, tool key, MCP stdio";
  },

  async echo() {
    await fetch(`${MOCK}/__mock/requests`, { method: "DELETE" });
    const { events } = await runTask("[mock:echo] hello swarm");
    assert(/Echo: hello swarm/.test(texts(events)), "echo text missing", summarize(events));
    assert(events.some((e) => e.type === "thinking" && /Echoing/.test(e.text)), "reasoning not streamed as thinking", summarize(events));
    const log = (await (await fetch(`${MOCK}/__mock/requests`)).json()).requests;
    const chat = log.find((x) => x.path.endsWith("/chat/completions"));
    assert(chat?.headers["x-swarm-e2e"] === "hdr-e2e-key-openai-1234", "custom header with {key} not sent", chat);
    return "streamed text + thinking; custom header delivered";
  },

  async tools() {
    const { events } = await runTask("[mock:tools] run the tool script", { timeout: 90_000 });
    const t = tools(events);
    assert(t.map((x) => x.name).join() === "bash,write_file,read_file", `tool order ${t.map((x) => x.name)}`, summarize(events));
    assert(t.every((x) => x.status === "ok"), "a tool failed", summarize(events));
    assert(/swarm-mock-ok/.test(t[0].output ?? ""), "bash output not streamed into card", t[0]);
    assert(/All done\. Shell said swarm-mock-ok; file says hello from mock/.test(texts(events)), "final answer wrong", summarize(events));
    return "bash → write_file → read_file → answer";
  },

  async parallel() {
    const { events } = await runTask("[mock:parallel] fan out", { timeout: 60_000 });
    assert(tools(events).length === 3, "expected 3 tool calls", summarize(events));
    assert(/saw A, saw B/.test(texts(events)), "parallel results not combined", summarize(events));
    return "3 tools in one turn";
  },

  async plan() {
    const { events, all } = await runTask("[mock:plan] make a plan", { timeout: 60_000 });
    const plans = all.filter((e) => e.type === "plan");
    assert(plans.length && plans.at(-1).items.every((i) => i.status === "done"), "plan not completed", summarize(events));
    assert(/Plan complete/.test(texts(events)), "no final text", summarize(events));
    return "plan created and completed";
  },

  async badtool() {
    const { events } = await runTask("[mock:badtool] call a bogus tool", { timeout: 60_000 });
    assert(/Tool error seen: yes/.test(texts(events)), "unknown tool not reported back to the model", summarize(events));
    return "unknown tool → error result → model recovers";
  },

  async ratelimit() {
    // Throttling teaches the router a limit for that provider, so use a throwaway one.
    const { events, ms } = await withScratchProvider("Throttled mock", () => runTask("[mock:ratelimit] go", { timeout: 90_000 }));
    assert(/Recovered after a 429/.test(texts(events)), "did not recover from 429", summarize(events));
    assert(notices(events).some((n) => /rate|limit|wait|pac/i.test(n.text)), "no visible notice about the 429", summarize(events));
    return `429 + retry-after handled in ${(ms / 1000).toFixed(1)}s`;
  },

  async flaky() {
    const { events } = await withScratchProvider("Flaky mock", () => runTask("[mock:flaky] go", { timeout: 120_000 }));
    assert(/Recovered after 2 server errors/.test(texts(events)), "did not recover from 503s", summarize(events));
    return "two 503s retried";
  },

  async failover() {
    // A broken provider first in priority: the router must fail over to the working one.
    let r = await api("POST", "/api/connections", { type: "llm", preset: "custom", label: "Broken first", baseUrl: `${MOCK}/v1`, apiKey: "bad-key", model: "mock" });
    const brokenId = r.json.id;
    await api("PUT", "/api/connections", { order: [brokenId, ctx.openaiId] });
    const { events } = await runTask("[mock:echo] failover please", { timeout: 60_000 });
    await api("DELETE", `/api/connections?type=llm&id=${brokenId}`);
    assert(/Echo: failover please/.test(texts(events)), "no answer after failover", summarize(events));
    assert(notices(events).some((n) => /Broken first/.test(n.text)), "failover not surfaced", summarize(events));
    return "401 on #1 → answered by #2";
  },

  async stop() {
    let seen = false;
    const sid = (await api("POST", "/api/sessions")).json.session.id;
    const p = runTask("[mock:slow] talk slowly", { sessionId: sid, timeout: 30_000, onEvent: (e) => e.type === "text" && e.text?.length > 20 && (seen = true) });
    for (let i = 0; i < 100 && !seen; i++) await sleep(100);
    assert(seen, "slow stream never started");
    const t0 = Date.now();
    await api("POST", `/api/sessions/${sid}/stop`);
    const { events } = await p;
    const ms = Date.now() - t0;
    assert(ms < 5000, `stop took ${ms}ms`);
    assert(!/tick299/.test(texts(events)), "stream finished despite stop");
    const again = await runTask("[mock:echo] still alive after stop", { sessionId: sid, timeout: 30_000 });
    assert(/still alive after stop/.test(texts(again.events)), "session unusable after stop", summarize(again.events));
    return `stopped in ${ms}ms, session continues`;
  },

  async mcp() {
    const { events } = await runTask("[mock:mcp] use the mcp tool", { timeout: 120_000 });
    const t = tools(events).find((x) => /^mcp__mock-mcp__echo$/.test(x.name));
    assert(t?.status === "ok", "MCP tool not called", summarize(events));
    assert(/MCP said: mcp-echo:via-mcp \(secret set\) \(ref ok\) \(leak no\)/.test(texts(events)), "MCP env: own secret + ${VAR} key ref, nothing else from the server env", summarize(events));
    return "agent called a Settings-added MCP server (own env + ${VAR} key ref delivered, server env not leaked)";
  },

  async search() {
    // web_search uses Settings tool keys in catalog order; a rejected Brave key falls through to Tavily.
    let r = await api("POST", "/api/connections", { type: "tool", preset: "brave", apiKey: "bad-key" });
    assert(r.status === 200, "save brave key", r.json);
    const braveId = r.json.connections.find((x) => x.type === "tool" && x.preset === "brave")?.id;
    r = await api("POST", "/api/connections", { type: "tool", preset: "tavily", apiKey: "tvly-e2e-0000" });
    const tavilyId = r.json.connections.find((x) => x.type === "tool" && x.preset === "tavily")?.id;
    assert(braveId && tavilyId, "tool key ids", r.json);
    await fetch(`${MOCK}/__mock/requests`, { method: "DELETE" });
    try {
      const { events } = await runTask("[mock:search] look it up", { timeout: 90_000 });
      const out = texts(events);
      assert(/Search said: 1\. Mock tavily result for swarm agents \| via=tavily/.test(out), "web_search should fall through to tavily", summarize(events));
      const hits = (await (await fetch(`${MOCK}/__mock/requests`)).json()).requests.filter((x) => x.search);
      assert(hits.map((x) => `${x.search}:${x.status}`).join(",") === "brave:401,tavily:200", "search order", hits);
      return "brave 401 → tavily 200, result reached the model";
    } finally {
      await api("DELETE", `/api/connections?type=tool&id=${braveId}`);
      await api("DELETE", `/api/connections?type=tool&id=${tavilyId}`);
    }
  },

  async browser() {
    // Real headless Chrome via the browser tool against the mock site.
    const { events } = await runTask("[mock:browser] try the browser", { timeout: 150_000 });
    const out = texts(events);
    assert(/Browser: download=ok dialog=ok upload=ok recover=ok popup=ok file=ok/.test(out), "browser download/dialog/upload/recover/popup", { said: out.slice(-400), tools: tools(events).map((t) => `${t.name}:${t.status}`) });
    return "download saved + read back, alert reported, upload, failed click recovered, popup followed";
  },

  async files() {
    // /api/files: previews only inside the task's folder, credential files blocked, active content sandboxed.
    const { sid, events } = await runTask("[mock:files] make fixtures", { timeout: 60_000 });
    assert(/Files: made/.test(texts(events)), "fixtures", summarize(events));
    const get = (p, extra = "") => fetch(`${BASE}/api/files?session=${sid}&path=${encodeURIComponent(p)}${extra}`);
    let r = await get("table.csv", "&meta=1");
    const m = await r.json();
    assert(r.status === 200 && m.kind === "table" && m.name === "table.csv", "csv meta", m);
    r = await get("table.csv");
    assert(r.status === 200 && (await r.text()).includes('"Widget, large"'), "csv body");
    r = await get("evil.html");
    assert(/sandbox/.test(r.headers.get("content-security-policy") ?? "") && r.headers.get("x-content-type-options") === "nosniff", "html must be sandboxed", Object.fromEntries(r.headers));
    r = await get(".env");
    assert(r.status === 403, `.env must be blocked (${r.status})`);
    r = await get("/etc/hosts");
    assert(r.status === 404, `outside folder must 404 (${r.status})`);
    r = await get("../../../../../../etc/hosts");
    assert(r.status === 404, `traversal must 404 (${r.status})`);
    r = await fetch(`${BASE}/api/files?session=nope&path=table.csv`);
    assert(r.status === 404, `unknown session (${r.status}: ${await r.text()})`);
    r = await get("long.txt", "&download=1");
    assert(/attachment/.test(r.headers.get("content-disposition") ?? ""), "download disposition");
    return "csv meta/body, html sandboxed + nosniff, .env 403, outside/traversal 404, download";
  },

  async anthropic() {
    // Same tool script over the native Anthropic protocol, with a Bedrock-style bearer header.
    const r = await api("POST", "/api/connections", { type: "llm", preset: "custom-anthropic", label: "Mock Anthropic", baseUrl: MOCK, apiKey: "e2e-key-anthropic-4321", model: "mock", headers: { Authorization: "Bearer {key}" } });
    assert(r.status === 200, "save anthropic-compatible", r.json);
    const anthId = r.json.id;
    const tr = await api("POST", "/api/connections/test", { type: "llm", id: anthId });
    assert(tr.json.ok && tr.json.models.length > 3, "anthropic model list", tr.json);
    await api("POST", "/api/connections", { type: "llm", id: ctx.openaiId, enabled: false });
    await fetch(`${MOCK}/__mock/requests`, { method: "DELETE" });
    try {
      const { events } = await runTask("[mock:tools] over anthropic", { timeout: 90_000 });
      assert(/All done\. Shell said swarm-mock-ok; file says hello from mock/.test(texts(events)), "anthropic tool loop failed", summarize(events));
      const log = (await (await fetch(`${MOCK}/__mock/requests`)).json()).requests;
      const m = log.find((x) => x.path.endsWith("/messages"));
      assert(m && /bearer/.test(m.headers.authorization ?? "") && !m.headers["x-api-key"], "bearer auth not used for anthropic", m);
    } finally {
      await api("POST", "/api/connections", { type: "llm", id: ctx.openaiId, enabled: true });
      await api("DELETE", `/api/connections?type=llm&id=${anthId}`);
    }
    return "native Anthropic stream + tools + bearer header";
  },

  async compaction() {
    // The mock reports a 125k-token prompt; on the next message the agent must compact (window guess 128k).
    const first = await runTask("[mock:bigcontext] fill the window", { timeout: 60_000 });
    const { events } = await runTask("[mock:echo] after the squeeze", { sessionId: first.sid, timeout: 120_000 });
    const comp = events.filter((e) => e.type === "compaction");
    assert(comp.length && comp.every((e) => e.done), "no completed compaction", summarize(events));
    assert(/Echo: after the squeeze/.test(texts(events)), "no answer after compaction", summarize(events));
    return `${comp.length} compaction step(s): ${comp.map((e) => e.reason).join(", ")}`;
  },

  async loop() {
    const { events } = await runTask("[mock:loop] repeat forever", { timeout: 120_000 });
    assert(notices(events).some((n) => /repeat|same/i.test(n.text)), "identical-call loop not stopped", summarize(events));
    return `stopped after ${tools(events).length} identical calls`;
  },
};

// ---------- main ----------

async function main() {
  // "connections" saves the mock provider every agent case uses, so it always runs first when agent cases are selected.
  const order = ONLY ? [...new Set([...(ONLY.some((o) => o !== "catalog") ? ["connections"] : []), ...ONLY])].filter((k) => k in cases) : Object.keys(cases);
  console.log(c.d(`SWARM_HOME=${HOME}\nmock LLM ${MOCK}  app ${BASE}`));
  start(process.execPath, [path.join(ROOT, "tests/mock-llm.mjs"), String(MOCK_PORT)], { MOCK_WORKDIR: WORK }, path.join(HOME, "mock-llm.log"));
  await waitFor(`${MOCK}/__mock/health`, 10_000, "mock LLM");
  if (!opt("--url")) {
    const env = { SWARM_HOME: HOME, NEXT_DIST_DIR: flag("--prod") ? ".next-e2e-prod" : ".next-e2e", NEXT_TELEMETRY_DISABLED: "1", SWARM_STALL_MS: "30000", SWARM_SEARCH_MOCK: `${MOCK}/search`, E2E_SERVER_CANARY: "canary-1", SWARM_E2E_CANARY: "canary-2", SWARM_BROWSER_HEADLESS: "1" };
    const next = path.join(ROOT, "node_modules/.bin/next");
    if (flag("--prod")) {
      console.log(c.d("building (next build)…"));
      const b = spawn(next, ["build"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
      const code = await new Promise((r) => b.on("exit", r));
      if (code) throw new Error(`next build failed (${code})`);
      start(next, ["start", "-H", "127.0.0.1", "-p", String(PORT)], env, path.join(HOME, "next.log"));
    } else start(next, ["dev", "-H", "127.0.0.1", "-p", String(PORT)], env, path.join(HOME, "next.log"));
    await waitFor(`${BASE}/api/sessions`, 120_000, "Next server");
  }
  let failed = 0;
  for (const name of order) {
    const t0 = Date.now();
    try {
      const note = await cases[name]();
      console.log(`${c.g("✓")} ${name} ${c.d(`${((Date.now() - t0) / 1000).toFixed(1)}s`)}  ${note ?? ""}`);
    } catch (e) {
      failed++;
      console.log(`${c.r("✗")} ${name}: ${e.message}`);
      if (e.extra) console.log(c.d(typeof e.extra === "string" ? e.extra : JSON.stringify(e.extra, null, 2)).split("\n").map((l) => `    ${l}`).join("\n"));
    }
  }
  console.log(failed ? c.r(`\n${failed} failed`) : c.g(`\nall ${order.length} passed`));
  if (failed) console.log(c.d(`logs: ${HOME}/next.log, ${HOME}/mock-llm.log`));
  else if (!flag("--keep")) fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(c.r(e.stack ?? String(e)));
  console.log(c.d(`logs: ${HOME}`));
  process.exit(1);
});
