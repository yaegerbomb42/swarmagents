#!/usr/bin/env node
// Adversarial multi-account test against a RUNNING server in server mode (open sign-up). It signs up three fresh
// accounts, alice, bob and mallory (the attacker), with random passwords, and checks that no account can see or
// act on another's sessions, SSE streams, background tasks and their stream, files, connections/keys, storage
// or browser, and that the admin API refuses them.
// With TENANT_MOCK set (the mock LLM as the SERVER can reach it), each account brings its own key (BYOK) and real
// agent runs check: the right key per account, the attacker's shell and file tools can't read other homes,
// auth.db or its own root-owned settings, and browser cookies don't cross accounts.
//
//   TENANT_BASE=http://127.0.0.1:3499 [TENANT_MOCK=http://host.docker.internal:37995] node tests/tenant-isolation.mjs
//
// The server must run with SWARM_MODE=server SWARM_SIGNUP=open (and SWARM_SANDBOX=uid for the OS checks).
import crypto from "node:crypto";

const BASE = (process.env.TENANT_BASE ?? "").replace(/\/$/, "");
const MOCK = (process.env.TENANT_MOCK ?? "").replace(/\/$/, "");
if (!BASE) {
  console.log("tenant-isolation: skipped (set TENANT_BASE to a server-mode build with SWARM_SIGNUP=open)");
  process.exit(0);
}
const rand = () => crypto.randomBytes(4).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const results = [];
async function t(name, fn) {
  try {
    const note = await fn();
    pass++;
    console.log(`  ok ${name}${note ? `  (${note})` : ""}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${e.message}`);
    results.push(name);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg);
};

async function call(who, method, p, body, extra = {}) {
  const r = await fetch(`${BASE}${p}`, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(who?.cookie ? { Cookie: who.cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

async function signup(name) {
  const username = `${name}-${rand()}`;
  const password = crypto.randomBytes(16).toString("base64url");
  const r = await fetch(`${BASE}/api/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const set = r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""];
  const c = set.map((s) => s.split(";")[0]).find((s) => s.startsWith("swarm_auth="));
  if (r.status !== 200 || !c) throw new Error(`sign-up ${username} → ${r.status} ${await r.text()}`);
  return { name, username, cookie: c, secret: `tenant-secret-${name}-${rand()}` };
}

/** Open an SSE stream and collect `data:` frames until closed. */
function sse(who, p) {
  const ctrl = new AbortController();
  const frames = [];
  const status = fetch(`${BASE}${p}`, { headers: { Accept: "text/event-stream", ...(who?.cookie ? { Cookie: who.cookie } : {}) }, signal: ctrl.signal }).then(async (r) => {
    if (!r.ok || !r.body) return r.status;
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
            buf = buf.slice(i + 2);
            if (line) frames.push(line.slice(6));
          }
        }
      } catch {}
    })();
    return r.status;
  });
  return { frames, status, close: () => ctrl.abort() };
}

/** Run one message in a fresh session of `who` and return the final text. */
async function run(who, text, timeout = 90_000) {
  const s = await call(who, "POST", "/api/sessions");
  ok(s.status === 200, `create session → ${s.status}`);
  const sid = s.json.session.id;
  const stream = sse(who, `/api/sessions/${sid}`);
  await stream.status;
  await sleep(150);
  const sent = await call(who, "POST", `/api/sessions/${sid}`, { text });
  ok(sent.status === 200, `send → ${sent.status} ${sent.text.slice(0, 200)}`);
  const t0 = Date.now();
  let saw = false;
  while (Date.now() - t0 < timeout) {
    await sleep(300);
    const ops = stream.frames.map((f) => JSON.parse(f));
    if (ops.some((o) => o.op === "running" && o.running)) saw = true;
    if (saw && ops.some((o, i) => o.op === "running" && !o.running && ops.slice(0, i).some((x) => x.op === "running" && x.running))) break;
  }
  stream.close();
  // Apply the op stream the way the UI does: text and tool output arrive as appended patches.
  const evs = new Map();
  for (const f of stream.frames) {
    const o = JSON.parse(f);
    if (o.op === "snapshot") for (const e of o.events) evs.set(e.id, e);
    else if (o.op === "add") evs.set(o.event.id, { ...o.event });
    else if (o.op === "patch" && evs.has(o.id)) {
      const e = evs.get(o.id);
      Object.assign(e, o.patch);
      if (o.append) e[o.append.field] = (e[o.append.field] ?? "") + o.append.value;
    }
  }
  const list = [...evs.values()];
  const all = JSON.stringify(list);
  if (process.env.TENANT_DEBUG) console.log("    [debug]", sid, list.map((e) => `${e.type}${e.name ? `:${e.name}` : ""} ${String(e.text ?? e.output ?? "").slice(0, 300)}`).join("\n      "));
  const reply = list.filter((e) => e.type === "text").map((e) => e.text).join("\n");
  const notes = list.filter((e) => e.type === "notice").map((e) => e.text).join(" | ");
  return { sid, text: reply || `(no reply; notices: ${notes.slice(0, 300)})`, raw: all };
}

console.log(`tenant-isolation against ${BASE}${MOCK ? ` (agent runs via ${MOCK})` : " (no TENANT_MOCK: API checks only)"}`);

const anon = null;
// A brand-new server may still want the first account to present a bootstrap invite (older account layer). For a
// throwaway test server only: TENANT_FIRST_INVITE creates a scratch first account so the three below are ordinary.
const me = await call(anon, "GET", "/api/me");
if (me.json?.needsAdmin && process.env.TENANT_FIRST_INVITE) {
  const r = await fetch(`${BASE}/api/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `first-${rand()}`, password: crypto.randomBytes(16).toString("base64url"), invite: process.env.TENANT_FIRST_INVITE }) });
  if (r.status !== 200) throw new Error(`first account → ${r.status}`);
}
const alice = await signup("alice");
const bob = await signup("bob");
const mal = await signup("mallory");

await t("signed-out requests are refused everywhere", async () => {
  for (const p of ["/api/sessions", "/api/runtime/tasks", "/api/runtime/stream", "/api/files?path=/etc/passwd", "/api/connections", "/api/storage", "/api/admin/analytics", "/api/settings/subagents"]) {
    const r = await call(anon, "GET", p);
    ok([401, 403].includes(r.status), `${p} → ${r.status}`);
  }
});

await t("keys and connections are per account (BYOK); another account sees none of them", async () => {
  for (const u of [alice, bob, mal]) {
    let r = await call(u, "POST", "/api/connections", { type: "tool", preset: "custom-key", envVar: `T_${u.name.toUpperCase()}_KEY`, apiKey: u.secret });
    ok(r.status === 200, `${u.name} tool key → ${r.status} ${r.text.slice(0, 120)}`);
    if (MOCK) {
      r = await call(u, "POST", "/api/connections", { type: "llm", preset: "custom", label: `LLM ${u.name}`, baseUrl: `${MOCK}/v1`, apiKey: `${u.secret}-llm`, model: "mock" });
      ok(r.status === 200, `${u.name} provider → ${r.status} ${r.text.slice(0, 160)}`);
    }
  }
  const m = await call(mal, "GET", "/api/connections");
  ok(m.status === 200, `list → ${m.status}`);
  ok(!m.text.includes("T_ALICE_KEY") && !m.text.includes("T_BOB_KEY") && !m.text.includes("LLM alice"), "mallory sees another account's connections");
  for (const u of [alice, bob, mal]) ok(!m.text.includes(u.secret), "a raw key came back");
});

let aSid;
await t("sessions: the attacker can't list, read, stream, send to, stop, delete or upload into another account's session", async () => {
  const s = await call(alice, "POST", "/api/sessions");
  ok(s.status === 200, `alice create → ${s.status} ${s.text.slice(0, 160)}`);
  aSid = s.json.session.id;
  const list = await call(mal, "GET", "/api/sessions");
  ok(list.status === 200 && !list.text.includes(aSid), "listed");
  for (const [m, p, body] of [
    ["GET", `/api/sessions/${aSid}/events`],
    ["POST", `/api/sessions/${aSid}`, { text: "[mock:echo] hijack" }],
    ["POST", `/api/sessions/${aSid}/stop`],
    ["DELETE", `/api/sessions/${aSid}`],
    ["GET", `/api/browser/stream?session=${aSid}`],
    ["GET", `/api/browser/control?session=${aSid}`],
    ["GET", `/api/files?session=${aSid}&path=x`],
  ]) {
    const r = await call(mal, m, p, body);
    ok([403, 404].includes(r.status), `${m} ${p} → ${r.status}`);
  }
  const st = sse(mal, `/api/sessions/${aSid}`);
  const code = await st.status;
  st.close();
  ok([403, 404].includes(code), `SSE → ${code}`);
  const still = await call(alice, "GET", `/api/sessions/${aSid}/events`);
  ok(still.status === 200, "alice's session survived");
});

await t("background tasks and the task stream: no cross-account view, no cancel/approve/delete", async () => {
  const mStream = sse(mal, "/api/runtime/stream");
  ok((await mStream.status) === 200, "mallory's own task stream opens");
  const aStream = sse(alice, "/api/runtime/stream");
  await aStream.status;
  await sleep(300);
  const marker = `alice-secret-task-${rand()}`;
  const c = await call(alice, "POST", "/api/runtime/tasks", { prompt: `[mock:echo] ${marker}`, title: marker });
  ok(c.status === 200, `alice task → ${c.status} ${c.text.slice(0, 160)}`);
  const id = c.json.task.id;
  // Her own stream must show it (live, or at the latest on the route's 10s ownership sweep). Mallory's must never.
  const t0 = Date.now();
  while (!aStream.frames.join("\n").includes(marker) && Date.now() - t0 < 13_000) await sleep(250);
  const lag = Date.now() - t0;
  await sleep(1000);
  mStream.close();
  aStream.close();
  ok(aStream.frames.join("\n").includes(marker), "alice's own stream shows her task");
  const note = lag > 3000 ? `alice's own new task reached her stream only after ${(lag / 1000).toFixed(1)}s (sweep, not live)` : "";
  ok(!mStream.frames.join("\n").includes(marker) && !mStream.frames.join("\n").includes(id), "mallory's stream received alice's task");
  const list = await call(mal, "GET", "/api/runtime/tasks");
  ok(list.status === 200 && !list.text.includes(id), "listed to mallory");
  for (const [m, p, body] of [
    ["GET", `/api/runtime/tasks/${id}`],
    ["POST", `/api/runtime/tasks/${id}`, { action: "cancel" }],
    ["POST", `/api/runtime/tasks/${id}`, { action: "approve" }],
    ["DELETE", `/api/runtime/tasks/${id}`],
  ]) {
    const r = await call(mal, m, p, body);
    // 404, or a 200 that says nothing happened ({ ok: false }); "alice's task untouched" below is the real check.
    ok(r.status === 404 || (r.status === 200 && r.json?.ok === false), `${m} ${p} ${body?.action ?? ""} → ${r.status} ${r.text.slice(0, 80)}`);
  }
  const mine = await call(alice, "GET", `/api/runtime/tasks/${id}`);
  ok(mine.status === 200 && mine.json.task.status !== "cancelled", "alice's task untouched");
  return note;
});

await t("files API: no paths outside the account's own area", async () => {
  for (const p of ["/etc/passwd", "../../auth.db", "../../../auth.db", "/data/auth.db", `../../users`, "~/../../auth.db"]) {
    const r = await call(mal, "GET", `/api/files?path=${encodeURIComponent(p)}`);
    ok([400, 403, 404].includes(r.status) && !/SQLite format|root:x:0/.test(r.text), `${p} → ${r.status}`);
  }
});

await t("storage and admin views are per account; admin API refuses non-admins", async () => {
  const s = await call(mal, "GET", "/api/storage");
  ok(s.status === 200 && !s.text.includes(aSid), "storage lists another account's chat");
  ok(s.json.limit === 512 * 1024 * 1024, `default quota ${s.json.limit}`);
  const del = await call(mal, "POST", "/api/storage", { action: "delete", id: aSid });
  ok(del.status === 404, `delete alice's chat via storage → ${del.status}`);
  for (const [m, p, body] of [
    ["GET", "/api/admin/analytics"],
    ["POST", "/api/admin/users", { userId: "0000000000000000", quotaMB: 99999 }],
  ]) {
    const r = await call(mal, m, p, body);
    ok(r.status === 403, `${m} ${p} → ${r.status}`);
  }
});

if (MOCK) {
  await t("agent runs use each account's own key", async () => {
    await fetch(`${MOCK}/__mock/requests`, { method: "DELETE" }).catch(() => {});
    const a = await run(alice, "[mock:echo] hi from alice");
    const b = await run(bob, "[mock:echo] hi from bob");
    ok(/Echo: hi from alice/.test(a.text) && /Echo: hi from bob/.test(b.text), `replies: ${a.text.slice(0, 80)} | ${b.text.slice(0, 80)}`);
  });

  await t("the attacker's agent can't read auth.db, other homes, or its own root-owned settings, and can't write outside its workspace", async () => {
    const r = await run(mal, "[mock:attack] look around");
    ok(/Attack:/.test(r.text), `no report: ${r.text.slice(0, 200)}`);
    ok(/sqlite=false/.test(r.text), `auth.db was readable: ${r.text}`);
    ok(/keys=false/.test(r.text), `settings/keys were readable: ${r.text}`);
    ok(/escape=refused/.test(r.text), `wrote outside the workspace: ${r.text}`);
    ok(!/uid=0\b/.test(r.text), `tools run as root: ${r.text}`);
    for (const u of [alice, bob]) ok(!r.raw.includes(u.secret), `saw ${u.name}'s key`);
    return (r.text.match(/uid=\d+/) ?? [""])[0];
  });

  await t("browser cookies don't cross accounts", async () => {
    const v = `a${rand()}`;
    const set = await run(alice, `[mock:cookie] set ${v}`, 150_000);
    // Fail-closed is isolated too: a server that hasn't got per-user browsers yet refuses the tool for everyone.
    if (/browser isn't available on this multi-user server/.test(set.raw)) return "browser disabled on this server (fail-closed); per-user contexts not live yet";
    ok(new RegExp(`seen=\\[tenant=${v}\\]`).test(set.text), `set: ${set.text.slice(0, 160)}`);
    const back = await run(alice, "[mock:cookie] show", 150_000);
    ok(back.text.includes(`tenant=${v}`), `alice's own browser kept it: ${back.text.slice(0, 160)}`);
    const m = await run(mal, "[mock:cookie] show", 150_000);
    ok(/Cookie: show/.test(m.text) && !m.text.includes(v), `mallory's browser sent alice's cookie: ${m.text.slice(0, 160)}`);
  });
}

console.log(`tenant-isolation: ${pass}/${pass + fail} pass${fail ? `; FAILED: ${results.join("; ")}` : ""}`);
process.exit(fail ? 1 : 0);
