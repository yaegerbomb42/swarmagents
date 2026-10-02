#!/usr/bin/env node
// Live-viewer e2e (lane: browser). Drives the REAL route handlers
// (app/api/browser/stream, app/api/browser/control) in-process against a real Chromium and a real
// task session, so frames, the auth gate, take-over/hand-back and input injection are all exercised
// through the same code path the app uses.
//
// Run: npm run test:browser:viewer        (tsx tests/browser-viewer.mjs)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSite } from "./browser-fixture.mjs";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-viewer-home-"));
process.env.SWARM_HOME = HOME;
process.env.SWARM_BROWSER_HEADLESS = "1";

const { browserRuntime } = await import("../lib/browser/runtime.ts");
const { createSession } = await import("../lib/store.ts");
const streamRoute = await import("../app/api/browser/stream/route.ts");
const controlRoute = await import("../app/api/browser/control/route.ts");

let failures = 0;
const check = (name, cond, extra = "") => {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local-mode requests: 127.0.0.1 with no Origin resolves to the single local user (lib/auth). A
// manually built Request carries no Host header (fetch adds it at send time), so set it explicitly.
const HOST = { host: "127.0.0.1:3781" };
const api = (p) => new Request(`http://127.0.0.1:3781${p}`, { headers: { ...HOST, Accept: "text/event-stream" } });
const post = (p, body) =>
  new Request(`http://127.0.0.1:3781${p}`, { method: "POST", headers: { ...HOST, "Content-Type": "application/json" }, body: JSON.stringify(body) });

const site = await startSite();
const rt = browserRuntime();

/** Read SSE messages from the stream response until `stop` says we have enough. */
async function readStream(req, stop, ms = 8000) {
  const res = await streamRoute.GET(req);
  if (res.status !== 200) return { status: res.status, messages: [], why: `HTTP ${res.status}` };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const messages = [];
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return "done";
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        messages.push(JSON.parse(line.slice(6)));
        if (stop(messages)) return "enough";
      }
    }
  })();
  const why = await Promise.race([pump, sleep(ms).then(() => "timeout")]);
  try {
    await reader.cancel();
  } catch {}
  return { status: res.status, messages, why };
}

try {
  const meta = createSession();
  const sid = meta.id;
  const s = rt.acquire(sid);
  const page = await s.page();
  await page.goto(site.url + "/login", { waitUntil: "domcontentloaded" });

  // ── 1. The stream opens, sends a hello, then live frames with low delay ──
  const started = Date.now();
  const { status, messages, why } = await readStream(api(`/api/browser/stream?session=${sid}`), (m) => m.some((x) => x.type === "frame"), 9000);
  check("stream connects", status === 200, `HTTP ${status}`);
  check("stream sends a hello with live status", messages.some((m) => m.type === "hello" && m.status?.live === true));
  const frame = messages.find((m) => m.type === "frame");
  check("a frame arrives", !!frame, why);
  if (frame) {
    const delay = Date.now() - frame.ts;
    check("frame delay is under 500ms locally", delay < 500, `${delay}ms`);
    check("frame payload is a JPEG", typeof frame.data === "string" && frame.data.length > 200, `${frame.data.length} bytes`);
  }
  check("first frame arrives quickly", Date.now() - started < Number(process.env.VIEWER_BUDGET_MS || 3000), `${Date.now() - started}ms`);

  // ── 2. Status over HTTP ──
  let r = await controlRoute.GET(api(`/api/browser/control?session=${sid}`));
  let body = await r.json();
  check("status reports the live browser", body.status?.live === true && body.status?.controller === "agent", JSON.stringify({ live: body.status?.live, controller: body.status?.controller }));
  check("status carries the URL bar and tab strip", /127\.0\.0\.1/.test(body.status?.url ?? "") && Array.isArray(body.status?.tabs), body.status?.url);

  // ── 3. Input is refused while the agent is driving ──
  r = await controlRoute.POST(post("/api/browser/control", { session: sid, input: { kind: "mouse", action: "move", x: 10, y: 10 } }));
  check("input is refused while the agent drives", r.status === 409, `HTTP ${r.status}`);

  // ── 4. Take over, then the user's own input reaches the page ──
  r = await controlRoute.POST(post("/api/browser/control", { session: sid, takeOver: true }));
  body = await r.json();
  check("take over hands control to the user", r.status === 200 && body.status?.controller === "user", body.status?.controller);

  const box = await page.locator("#u").boundingBox();
  const mouse = [
    { kind: "mouse", action: "move", x: box.x + 5, y: box.y + 5 },
    { kind: "mouse", action: "down", x: box.x + 5, y: box.y + 5, button: 1 },
    { kind: "mouse", action: "up", x: box.x + 5, y: box.y + 5, button: 1 },
  ];
  for (const input of mouse) r = await controlRoute.POST(post("/api/browser/control", { session: sid, input }));
  check("viewer mouse events are accepted in control", r.status === 200, `HTTP ${r.status}`);
  for (const ch of "user") await controlRoute.POST(post("/api/browser/control", { session: sid, input: { kind: "key", action: "char", key: ch, text: ch } }));
  check("viewer keyboard types into the page", (await page.inputValue("#u")) === "user", await page.inputValue("#u"));

  r = await controlRoute.POST(post("/api/browser/control", { session: sid, input: { kind: "nonsense" } }));
  check("garbage input is rejected", r.status === 400, `HTTP ${r.status}`);

  // ── 5. Pause / resume and hand back ──
  r = await controlRoute.POST(post("/api/browser/control", { session: sid, cmd: { paused: true } }));
  check("pause is accepted", (await r.json()).status?.paused === true);
  r = await controlRoute.POST(post("/api/browser/control", { session: sid, handBack: true }));
  body = await r.json();
  check(
    "hand back returns control to the agent",
    body.status?.controller === "agent" && body.status?.paused === false,
    JSON.stringify({ c: body.status?.controller, p: body.status?.paused }),
  );

  // ── 6. A second viewer attaches without disturbing the session ──
  const again = await readStream(api(`/api/browser/stream?session=${sid}`), (m) => m.some((x) => x.type === "hello"), 4000);
  check("a second viewer attaches cleanly", again.messages.some((m) => m.type === "hello" && m.status?.live === true));

  // ── 7. Stop closes the browser and the viewer is told ──
  const closing = readStream(api(`/api/browser/stream?session=${sid}`), (m) => m.some((x) => x.type === "closed"), 8000);
  await sleep(200);
  r = await controlRoute.POST(post("/api/browser/control", { session: sid, cmd: { stop: true } }));
  check("stop closes the browser", r.status === 200, `HTTP ${r.status}`);
  const stopped = await closing;
  check("viewers are told the browser closed", stopped.messages.some((m) => m.type === "closed"), stopped.why);

  r = await controlRoute.GET(api(`/api/browser/control?session=${sid}`));
  check("status reports the browser is gone", (await r.json()).status?.live === false);

  // ── 8. Unknown / missing tasks are not streamable ──
  r = await controlRoute.GET(api("/api/browser/control?session=does-not-exist"));
  check("unknown task is refused", r.status === 404, `HTTP ${r.status}`);
  r = await controlRoute.GET(api("/api/browser/control?session="));
  check("missing task is refused", r.status === 404, `HTTP ${r.status}`);
  r = await streamRoute.GET(api("/api/browser/stream?session=does-not-exist"));
  check("the stream refuses an unknown task", r.status === 404, `HTTP ${r.status}`);
} finally {
  for (const s of rt.list()) await rt.release(s.key, "test done").catch(() => {});
  await site.close().catch(() => {});
}

console.log(failures ? `\n${failures} live-viewer check(s) failed` : "\nlive viewer: all checks passed");
process.exit(failures ? 1 : 0);