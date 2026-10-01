#!/usr/bin/env node
// Deterministic scripted LLM server for testing Swarm end to end without a real provider.
// Speaks both the OpenAI chat-completions protocol (/v1/chat/completions, /v1/models) and the Anthropic
// Messages protocol (/v1/messages, /v1/models), streaming, so the real adapters, router and agent loop run.
//
//   node tests/mock-llm.mjs [port]        (default 37901; MOCK_WORKDIR sets where scripted files go)
//   Settings -> OpenAI-compatible endpoint -> http://127.0.0.1:37901/v1, any key, model "mock"
//
// The scenario comes from a marker in the latest user message, e.g. "[mock:tools] do the thing", else from
// the model name ("mock-tools"), else "echo". The step within a scenario is the number of tool-result
// rounds since that user message, so replies are a pure function of the conversation.
//
// Scenarios: echo, tools, parallel, plan, ratelimit, flaky, auth, slow, bigcontext, loop, badtool, long.
// A key of "bad-key" is rejected with 401 everywhere. GET /__mock/requests returns the request log
// (method, path, headers minus auth values, scenario, step); DELETE /__mock/requests clears it.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 37901);
const WORKDIR = process.env.MOCK_WORKDIR || path.join(os.tmpdir(), "swarm-mock-work");
fs.mkdirSync(WORKDIR, { recursive: true });

const SCENARIOS = ["echo", "tools", "parallel", "plan", "ratelimit", "flaky", "auth", "slow", "bigcontext", "loop", "badtool", "long"];
const log = [];
const attempts = new Map(); // conversation hash -> request count, for ratelimit/flaky

// ---------- conversation analysis (protocol-neutral) ----------

/** Normalize either protocol's messages into [{role, text, toolResults}] */
function normalize(proto, body) {
  const out = [];
  for (const m of body.messages ?? []) {
    if (proto === "openai") {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        out.push({ role: "tool", text: String(m.content ?? "") });
        continue;
      }
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
      out.push({ role: m.role, text: text ?? "" });
    } else {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const r of results) out.push({ role: "tool", text: (Array.isArray(r.content) ? r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : String(r.content ?? "")) });
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text || !results.length) out.push({ role: m.role, text });
    }
  }
  return out;
}

function analyze(proto, body) {
  const msgs = normalize(proto, body);
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user" && msgs[i].text && !msgs[i].text.startsWith("(images returned")) {
      lastUser = i;
      break;
    }
  }
  const userText = lastUser >= 0 ? msgs[lastUser].text : "";
  const after = msgs.slice(lastUser + 1);
  const step = after.filter((m) => m.role === "assistant").length;
  const toolOutputs = after.filter((m) => m.role === "tool").map((m) => m.text);
  const marker = userText.match(/\[mock:([a-z]+)\]/);
  const fromModel = String(body.model ?? "").match(/^mock-([a-z]+)$/);
  let scenario = marker?.[1] ?? fromModel?.[1] ?? "echo";
  if (!SCENARIOS.includes(scenario)) scenario = "echo";
  // Compaction requests are answered with a summary whatever the scenario.
  if (/^Summarize this session for continuation/.test(userText)) scenario = "summary";
  const firstUser = msgs.find((m) => m.role === "user")?.text ?? "";
  const convo = crypto.createHash("sha1").update(`${scenario}|${firstUser}|${userText}|${step}`).digest("hex").slice(0, 12);
  const tools = (body.tools ?? []).map((t) => t.name ?? t.function?.name);
  return { userText, step, toolOutputs, scenario, convo, tools };
}

// ---------- scripts: what to say at each step ----------
// A reply is { thinking?, text?, calls?: [{name, input}], error?: {status, message, headers}, delayMs?, usageIn? }

function script(a) {
  const file = path.join(WORKDIR, `note-${a.convo.slice(0, 6)}.txt`);
  const n = attempts.get(a.convo) ?? 0;
  attempts.set(a.convo, n + 1);
  switch (a.scenario) {
    case "summary":
      return { text: "SUMMARY: the user is running a scripted mock test. Goals, files and state are as logged above; continue with the latest request." };
    case "tools":
      if (a.step === 0) return { thinking: "I'll run a command first.", calls: [{ name: "bash", input: { command: "echo swarm-mock-ok" } }] };
      if (a.step === 1) {
        const p = path.join(WORKDIR, "tools-note.txt");
        return { text: "Writing a file.", calls: [{ name: "write_file", input: { path: p, content: "hello from mock\nline two\n" } }] };
      }
      if (a.step === 2) return { calls: [{ name: "read_file", input: { path: path.join(WORKDIR, "tools-note.txt") } }] };
      return { text: `All done. Shell said ${a.toolOutputs.some((t) => t.includes("swarm-mock-ok")) ? "swarm-mock-ok" : "NOTHING"}; file says ${a.toolOutputs.at(-1)?.includes("hello from mock") ? "hello from mock" : "NOTHING"}.` };
    case "parallel":
      if (a.step === 0) {
        fs.writeFileSync(file, "parallel-a\n");
        return { calls: [{ name: "read_file", input: { path: file } }, { name: "search", input: { pattern: "parallel-a", path: WORKDIR } }, { name: "bash", input: { command: "echo parallel-b" } }] };
      }
      return { text: `Parallel results: ${a.toolOutputs.length} outputs; ${a.toolOutputs.some((t) => t.includes("parallel-a")) ? "saw A" : "no A"}, ${a.toolOutputs.some((t) => t.includes("parallel-b")) ? "saw B" : "no B"}.` };
    case "plan":
      if (a.step === 0) return { calls: [{ name: "plan", input: { items: [{ text: "Inspect", status: "done" }, { text: "Change", status: "active" }, { text: "Verify", status: "pending" }] } }] };
      if (a.step === 1) return { calls: [{ name: "plan", input: { items: [{ text: "Inspect", status: "done" }, { text: "Change", status: "done" }, { text: "Verify", status: "done" }] } }] };
      return { text: "Plan complete." };
    case "ratelimit":
      if (n === 0) return { error: { status: 429, message: "Rate limit reached for requests (mock)", headers: { "retry-after": "1" } } };
      return { text: `Recovered after a 429 (attempt ${n + 1}).` };
    case "flaky":
      if (n < 2) return { error: { status: 503, message: "upstream overloaded? no: service unavailable (mock)" } };
      return { text: `Recovered after ${n} server errors.` };
    case "auth":
      return { error: { status: 401, message: "invalid x-api-key (mock)" } };
    case "slow":
      return { text: Array.from({ length: 300 }, (_, i) => `tick${i} `).join(""), delayMs: 200 };
    case "bigcontext":
      return { text: `Reported a huge prompt (step ${a.step}).`, usageIn: 125_000 };
    case "loop":
      return { calls: [{ name: "bash", input: { command: "echo same-thing" } }] };
    case "badtool":
      if (a.step === 0) return { calls: [{ name: "no_such_tool", input: { x: 1 } }] };
      return { text: `Tool error seen: ${a.toolOutputs.some((t) => /unknown|not found|no such/i.test(t)) ? "yes" : "no"}.` };
    case "long":
      return { text: "## Long answer\n\n" + Array.from({ length: 200 }, (_, i) => `- line ${i + 1}: the quick brown fox jumps over the lazy dog.`).join("\n") };
    default:
      return { thinking: "Echoing the user.", text: `Echo: ${a.userText.replace(/\[mock:[a-z]+\]\s*/, "").slice(0, 500)}` };
  }
}

// ---------- streaming helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (s, size = 12) => (s ? s.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) : []);

async function streamOpenAI(res, body, reply, a, closed) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const id = `chatcmpl-mock-${a.convo}`;
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  for (const c of chunks(reply.thinking)) send({ reasoning_content: c });
  for (const c of chunks(reply.text)) {
    if (closed()) return;
    send({ content: c });
    if (reply.delayMs) await sleep(reply.delayMs);
  }
  (reply.calls ?? []).forEach((call, i) => {
    const args = JSON.stringify(call.input);
    send({ tool_calls: [{ index: i, id: `call_${a.convo}_${a.step}_${i}`, type: "function", function: { name: call.name, arguments: "" } }] });
    for (const c of chunks(args, 9)) send({ tool_calls: [{ index: i, function: { arguments: c } }] });
  });
  send({}, reply.calls?.length ? "tool_calls" : "stop");
  const prompt = reply.usageIn ?? Math.ceil(JSON.stringify(body.messages).length / 4);
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: Math.ceil(((reply.text ?? "").length + JSON.stringify(reply.calls ?? []).length) / 4), total_tokens: prompt } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function streamAnthropic(res, body, reply, a, closed) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const prompt = reply.usageIn ?? Math.ceil(JSON.stringify(body.messages).length / 4);
  ev("message_start", { message: { id: `msg_mock_${a.convo}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: prompt, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  let index = 0;
  if (reply.thinking) {
    ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
    for (const c of chunks(reply.thinking)) ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: c } });
    ev("content_block_delta", { index, delta: { type: "signature_delta", signature: `mock-sig-${a.convo}` } });
    ev("content_block_stop", { index });
    index++;
  }
  if (reply.text) {
    ev("content_block_start", { index, content_block: { type: "text", text: "" } });
    for (const c of chunks(reply.text)) {
      if (closed()) return;
      ev("content_block_delta", { index, delta: { type: "text_delta", text: c } });
      if (reply.delayMs) await sleep(reply.delayMs);
    }
    ev("content_block_stop", { index });
    index++;
  }
  for (const [i, call] of (reply.calls ?? []).entries()) {
    ev("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${a.convo}_${a.step}_${i}`, name: call.name, input: {} } });
    for (const c of chunks(JSON.stringify(call.input), 9)) ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: c } });
    ev("content_block_stop", { index });
    index++;
  }
  ev("message_delta", { delta: { stop_reason: reply.calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: Math.ceil((reply.text ?? "").length / 4) + 1 } });
  ev("message_stop", {});
  res.end();
}

// ---------- server ----------

function keyOf(req) {
  const auth = req.headers.authorization ?? "";
  return req.headers["x-api-key"] ?? req.headers["api-key"] ?? auth.replace(/^Bearer\s+/i, "");
}

function safeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = /authorization|api-key|x-api-key/i.test(k) ? `[${String(v).length} chars${String(v).startsWith("Bearer ") ? ", bearer" : ""}]` : v;
  return out;
}

const MODELS = ["mock", ...SCENARIOS.map((s) => `mock-${s}`)];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname.replace(/\/+$/, "");
  let raw = "";
  for await (const c of req) raw += c;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}
  let closed = false;
  res.on("close", () => (closed = true));
  const json = (status, data, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };

  if (p === "/__mock/requests") {
    if (req.method === "DELETE") {
      log.length = 0;
      attempts.clear();
    }
    return json(200, { requests: log });
  }
  if (p === "/__mock/health") return json(200, { ok: true, port: PORT, workdir: WORKDIR });

  const proto = p.endsWith("/messages") ? "anthropic" : "openai";
  const entry = { at: Date.now(), method: req.method, path: p, headers: safeHeaders(req.headers) };
  log.push(entry);
  if (log.length > 500) log.shift();

  if (keyOf(req) === "bad-key") {
    return proto === "anthropic" || req.headers["anthropic-version"]
      ? json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
      : json(401, { error: { message: "Incorrect API key provided (mock)", type: "invalid_request_error", code: "invalid_api_key" } });
  }

  if (req.method === "GET" && p.endsWith("/models")) {
    if (req.headers["anthropic-version"]) return json(200, { data: MODELS.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z", max_input_tokens: 200000 })), has_more: false, first_id: MODELS[0], last_id: MODELS.at(-1) });
    return json(200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "mock", context_length: 128000 })) });
  }

  if (req.method === "POST" && (p.endsWith("/chat/completions") || p.endsWith("/messages"))) {
    const a = analyze(proto, body);
    const reply = script(a);
    Object.assign(entry, { scenario: a.scenario, step: a.step, model: body.model, tools: a.tools.length, stream: !!body.stream, status: reply.error?.status ?? 200 });
    if (reply.error) {
      const e = reply.error;
      return proto === "anthropic"
        ? json(e.status, { type: "error", error: { type: e.status === 429 ? "rate_limit_error" : e.status === 401 ? "authentication_error" : "api_error", message: e.message } }, e.headers)
        : json(e.status, { error: { message: e.message, type: "mock_error", code: e.status } }, e.headers);
    }
    if (!body.stream) {
      // Non-streaming fallback (used by nothing in Swarm today, handy for curl).
      return json(200, { id: "chatcmpl-mock", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: reply.text ?? "" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    return proto === "anthropic" ? streamAnthropic(res, body, reply, a, () => closed) : streamOpenAI(res, body, reply, a, () => closed);
  }
  json(404, { error: { message: `mock: no route ${req.method} ${p}` } });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock-llm listening on http://127.0.0.1:${PORT}/v1 (workdir ${WORKDIR})`));
