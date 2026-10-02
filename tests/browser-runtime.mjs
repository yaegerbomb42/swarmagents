#!/usr/bin/env node
// Browser runtime e2e (lane: browser). Real headless Chromium, no LLM, no network beyond the
// local fixture site. Exercises the isolated per-task runtime directly:
//   isolation, limits (tabs/downloads), CDP screencast frames, take-over input, pause/hand-back,
//   resume after restart, crash recovery, recording, and the page shapes from browser-fixture.mjs.
//
// Run: npm run test:browser        (tsx tests/browser-runtime.mjs)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSite } from "./browser-fixture.mjs";

// Isolate persistence and force headless before the runtime module is imported.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-browser-home-"));
process.env.SWARM_HOME = HOME;
process.env.SWARM_BROWSER_HEADLESS = "1";

const { BrowserRuntime, DEFAULT_LIMITS } = await import("../lib/browser/runtime.ts");
const { dispatchInput } = await import("../lib/browser/screencast.ts");

let failures = 0;
const check = (name, cond, extra = "") => {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

const site = await startSite();
const rt = new BrowserRuntime({ ...DEFAULT_LIMITS, maxLive: 20 }, path.join(HOME, "browsers"));
const all = [];

try {
  // ── 1. Isolation: each task gets its own profile and downloads folder ──
  const a = rt.acquire("task-a");
  const b = rt.acquire("task-b");
  all.push(a, b);
  check("distinct profile dirs", a.dir !== b.dir, a.dir.split("/").pop());
  check("distinct download dirs", a.downloadsDir !== b.downloadsDir);

  const pa = await a.page();
  await pa.goto(site.url + "/login", { waitUntil: "domcontentloaded" });
  await pa.evaluate(() => (document.cookie = "task=aaa; path=/"));
  const pb = await b.page();
  await pb.goto(site.url + "/", { waitUntil: "domcontentloaded" });
  const aHas = await pa.evaluate(() => document.cookie);
  const bHas = await pb.evaluate(() => document.cookie);
  check("cookies do not leak between tasks", /task=aaa/.test(aHas) && !/task=aaa/.test(bHas), `a="${aHas}" b="${bHas}"`);

  // ── 2. A real login + multi-step form, driven by the agent ──
  const p = pa;
  await p.goto(site.url + "/login", { waitUntil: "domcontentloaded" });
  await p.fill("#u", "jimmy");
  await p.fill("#p", "s3cret");
  await p.click("#go");
  await p.waitForLoadState("domcontentloaded");
  check("login lands on /welcome", /\/welcome\?u=jimmy/.test(p.url()), p.url());

  await p.goto(site.url + "/form", { waitUntil: "domcontentloaded" });
  await p.fill("#name", "Jimmy Smith");
  await p.fill("#email", "jimmy@example.test");
  await p.click("#next1");
  await p.fill("#street", "1 Main St");
  await p.fill("#city", "Springfield");
  await p.click("#next2");
  await p.selectOption("#plan", "pro");
  await p.check("#agree");
  await p.click("#finish");
  await p.waitForLoadState("domcontentloaded");
  check("multi-step form submits all fields", /Signed up Jimmy Smith \(pro\)/.test(await p.textContent("#done")), p.url());

  // ── 3. Element that disappears: the failure is reported, not swallowed ──
  await p.goto(site.url + "/vanish", { waitUntil: "domcontentloaded" });
  await p.click("#trap");
  await sleep(450); // #gone is now detached
  const stale = await until(async () => {
    try {
      await p.click("#gone", { timeout: 1200 });
      return null;
    } catch (e) {
      return String(e.message).split("\n")[0];
    }
  }, 4000);
  check("stale element click fails loudly (so the tool can re-observe)", !!stale, stale ?? "no error");

  // ── 4. Modal, iframe and shadow DOM are reachable ──
  await p.goto(site.url + "/modal", { waitUntil: "domcontentloaded" });
  await p.click("#open");
  check("modal becomes visible", await p.isVisible("#mtext"));
  await p.click("#confirm");
  check("modal button works", (await p.title()) === "confirmed");

  await p.goto(site.url + "/iframe", { waitUntil: "domcontentloaded" });
  await p.frameLocator("#fr").locator("#inside").click();
  check("iframe content is clickable", (await p.title()) === "iframe-clicked");

  await p.goto(site.url + "/shadow", { waitUntil: "domcontentloaded" });
  await p.locator("#host").locator("#shadowbtn").click();
  check("shadow DOM button is clickable", (await p.title()) === "shadow-clicked");

  // ── 5. Infinite scroll ──
  await p.goto(site.url + "/scroll", { waitUntil: "domcontentloaded" });
  const before = await p.locator(".row").count();
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(300);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const after = await p.locator(".row").count();
  check("infinite scroll loads more rows", after > before, `${before} → ${after}`);

  // ── 6. CDP screencast frames arrive (the viewer's input) ──
  const seen = [];
  const off = a.onFrame((f) => seen.push(f));
  await p.goto(site.url + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(300);
  const gotFrame = await until(() => seen.length > 0, 6000);
  check("screencast emits frames", !!gotFrame, `${seen.length} frames, ${seen[0]?.data.length ?? 0} bytes`);
  off();

  // ── 7. Take-over: the user's own mouse + keyboard reach the page ──
  a.setController("user");
  check("hand over reports the user in control", a.controller === "user");
  let agentTurnResolved = false;
  void a.whenAgentTurn().then(() => (agentTurnResolved = true));
  await sleep(60);
  check("agent turn is held while the user drives", !agentTurnResolved);

  await p.goto(site.url + "/login", { waitUntil: "domcontentloaded" });
  const box = await p.locator("#u").boundingBox();
  await dispatchInput(a, { kind: "mouse", action: "move", x: box.x + 5, y: box.y + 5 });
  await dispatchInput(a, { kind: "mouse", action: "down", x: box.x + 5, y: box.y + 5, button: 1 });
  await dispatchInput(a, { kind: "mouse", action: "up", x: box.x + 5, y: box.y + 5, button: 1 });
  for (const ch of "typed") await dispatchInput(a, { kind: "key", action: "char", key: ch, text: ch });
  const typed = await p.inputValue("#u");
  check("take-over keyboard reaches the page", typed === "typed", `value="${typed}"`);
  check("take-over sets the pointer for the viewer", !!a.pointer, JSON.stringify(a.pointer));

  a.setController("agent");
  check("hand back releases the agent", await until(() => agentTurnResolved, 1000));

  // ── 8. Pause / resume ──
  a.setPaused(true);
  let resumed = false;
  void a.whenAgentTurn().then(() => (resumed = true));
  await sleep(60);
  check("pause holds the agent", !resumed);
  a.setPaused(false);
  check("resume releases the agent", await until(() => resumed, 1000));

  // ── 9. Downloads: saved inside the task folder, with size + type limits ──
  await p.goto(site.url + "/files", { waitUntil: "domcontentloaded" });
  await p.click("#dl");
  const csvPath = path.join(a.downloadsDir, "report.csv");
  const csv = await until(() => fs.existsSync(csvPath), 6000);
  check("download saved into the task downloads dir", !!csv, a.downloadsDir.replace(HOME, "~"));
  if (csv) check("download content is intact", /Widget/.test(fs.readFileSync(csvPath, "utf8")));

  await p.click("#dlexe");
  await sleep(800);
  check("disallowed file type is refused", !fs.existsSync(path.join(a.downloadsDir, "notes.exe")));

  const capped = rt.acquire("task-capped", { maxDownloadFileBytes: 1024 });
  all.push(capped);
  const cp = await capped.page();
  await cp.goto(site.url + "/files", { waitUntil: "domcontentloaded" });
  await cp.click("#dlbig");
  await sleep(1200);
  check("oversized download is refused", !fs.existsSync(path.join(capped.downloadsDir, "big.bin")));
  check("blocked downloads are reported to the agent", capped.drainNotes().some((n) => /Blocked download/.test(n)));

  // ── 10. Tab limit (the persistent context opens with one blank tab, so it counts) ──
  const tabbed = rt.acquire("task-tabs", { maxTabs: 2 });
  all.push(tabbed);
  await tabbed.page(); // the initial tab
  await tabbed.newPage(site.url + "/tab-one");
  let tabErr = "";
  try {
    await tabbed.newPage(site.url + "/tab-two");
  } catch (e) {
    tabErr = e.message;
  }
  check("tab limit is enforced", /Tab limit reached/.test(tabErr), tabErr);
  check("tab list reports the capped tabs", tabbed.tabs().length === 2, JSON.stringify(tabbed.tabs().map((t) => t.index)));

  // ── 11. Recording / replay ──
  const replay = rt.replay("task-a");
  check("session is recorded for replay", replay.some((e) => e.kind === "frame") && replay.some((e) => e.kind === "event"), `${replay.length} entries`);

  // ── 12. The TOOL itself: the fixture flows run through lib/tools/browser, not the runtime directly ──
  const { browser, browserSession } = await import("../lib/tools/browser.ts");
  const { browserRuntime } = await import("../lib/browser/runtime.ts");
  const toolRt = browserRuntime();
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tool-work-"));
  fs.writeFileSync(path.join(WORK, "upload-me.txt"), "hello from the workspace");
  const ctl = new AbortController();
  const toolCtx = { sessionId: "tool-task", cwd: WORK, signal: ctl.signal, onOutput: () => {}, setCwd: () => {}, setPlan: () => {} };
  const run = (input) => browser.run(input, toolCtx);

  let out = await run({ action: "goto", url: site.url + "/echo" });
  check("tool: goto returns an observation", /Interactive elements:/.test(out.content), out.content.split("\n")[0]);
  check("tool: goto includes a screenshot by default", !!out.images?.length);

  out = await run({ action: "type", selector: "#box", text: "hello" });
  out = await run({ action: "read" });
  check("tool: typed text lands in the page", /seen:hello/.test(out.content), out.content.split("\n").slice(-4).join(" "));

  out = await run({ action: "reload", screenshot: false });
  check("tool: screenshot:false skips the image", !out.images?.length);

  await run({ action: "goto", url: site.url + "/files" });
  out = await run({ action: "upload", selector: "#f", path: "upload-me.txt" });
  check("tool: upload attaches the workspace file", /Attached upload-me\.txt/.test(out.content), out.content.split("\n")[0]);

  out = await run({ action: "click", selector: "#dl" });
  const wsDl = path.join(WORK, "downloads", "report.csv");
  check("tool: download lands in the task workspace", fs.existsSync(wsDl) && /Downloaded report\.csv/.test(out.content), wsDl.replace(WORK, "~"));

  await run({ action: "goto", url: site.url + "/drag" });
  out = await run({ action: "drag", selector: "#src", to_selector: "#dst" });
  out = await run({ action: "read" });
  check("tool: drag drops the element", /dropped/.test(out.content), out.content.split("\n").slice(-3).join(" "));

  out = await run({ action: "goto", url: site.url + "/vanish" });
  await run({ action: "click", selector: "#trap" });
  await sleep(450);
  out = await run({ action: "click", selector: "#gone" });
  check("tool: a vanished element reports a re-observation instead of a stack trace", out.isError === true && /Interactive elements:/.test(out.content), out.content.split("\n")[0]);

  out = await run({ action: "tab_new", url: site.url + "/tab-one" });
  check("tool: tab_new opens a second tab", /Tab 2\/2: Tab one/.test(out.content), out.content.split("\n")[1]);
  out = await run({ action: "tab_switch", tab: 1 });
  check("tool: tab_switch returns to the first tab", /Tab 1\/2/.test(out.content), out.content.split("\n")[1]);
  await run({ action: "tab_close" });

  // Take-over: while the user holds the browser the tool waits instead of fighting for the mouse.
  const toolSession = browserSession("tool-task");
  toolSession.setController("user");
  const ctl2 = new AbortController();
  let heldDone = false;
  const held = browser.run({ action: "reload" }, { ...toolCtx, signal: ctl2.signal }).then((r) => ((heldDone = true), r));
  await sleep(200);
  check("tool: the agent holds while the user has the browser", !heldDone);
  ctl2.abort();
  const heldRes = await held;
  check("tool: an abort during take-over returns cleanly", /paused/.test(String(heldRes.content)), heldRes.content);
  toolSession.setController("agent");
  await toolRt.release("tool-task", "tool test done");

  // ── 13. Resume after a restart (new process would rebuild from the profile dir) ──
  await p.goto(site.url + "/scroll", { waitUntil: "domcontentloaded" });
  await a.rememberState();
  const savedUrls = a.lastUrls();
  await rt.release("task-a", "test: simulate restart");
  check("release closes the session", !rt.get("task-a"));
  const reopened = await rt.resumeAll();
  const a2 = rt.get("task-a");
  check("resume reopens the same session key", !!a2 && reopened.includes("task-a"), JSON.stringify(reopened));
  if (a2) {
    const hasTab = await until(() => a2.tabs().length > 0, 6000);
    check("resumed tabs point at the saved URLs", !!hasTab && a2.tabs().some((t) => savedUrls.some((u) => t.url.startsWith(u.split("?")[0]))), JSON.stringify(a2.tabs()));
    all.push(a2);
  }

  // ── 13. Crash recovery: a killed browser is cleaned up and can be relaunched ──
  const c = rt.acquire("task-crash");
  all.push(c);
  await c.page().then((pg) => pg.goto(site.url + "/", { waitUntil: "domcontentloaded" }));
  const cctx = await c.context();
  await cctx.close().catch(() => {}); // Chromium processes die; the session must notice
  const noticed = await until(() => rt.get("task-crash") === undefined, 5000);
  check("killed browser is noticed and cleaned up", !!noticed);
  const c2 = rt.acquire("task-crash");
  all.push(c2);
  const relaunched = await until(
    () =>
      c2
        .page()
        .then((pg) => pg.goto(site.url + "/", { waitUntil: "domcontentloaded" }))
        .then(() => true)
        .catch(() => false),
    15000,
  );
  check("browser relaunches after a crash", !!relaunched);

  // ── 14. Idle reaping on a runtime with a short idle cap ──
  const idleRt = new BrowserRuntime({ ...DEFAULT_LIMITS, idleMs: 300 }, path.join(HOME, "browsers-idle"));
  const idle = idleRt.acquire("task-idle");
  all.push(idle);
  await idle.page().then((pg) => pg.goto(site.url + "/", { waitUntil: "domcontentloaded" }));
  await sleep(500);
  await idleRt.reap();
  check("idle session is reaped", !idleRt.get("task-idle"));

  // ── 15. Wall-clock cap on a runtime with a short lifetime ──
  const wallRt = new BrowserRuntime({ ...DEFAULT_LIMITS, wallMs: 200 }, path.join(HOME, "browsers-wall"));
  const wall = wallRt.acquire("task-wall");
  all.push(wall);
  await wall.page().then((pg) => pg.goto(site.url + "/", { waitUntil: "domcontentloaded" }));
  await sleep(300);
  await wallRt.reap();
  check("wall-clock limit is reaped", !wallRt.get("task-wall"));
} finally {
  for (const s of all) await s.close("test done").catch(() => {});
  await site.close().catch(() => {});
}

console.log(failures ? `\n${failures} browser runtime check(s) failed` : "\nbrowser runtime: all checks passed");
process.exit(failures ? 1 : 0);