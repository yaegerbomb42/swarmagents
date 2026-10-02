#!/usr/bin/env node
// Capture real artifacts for docs/ui/browser: CDP screencast frames and before/after shots taken
// while the runtime drives the fixture site. Run manually after a UI change:
//
//   npm run test:browser:capture        (tsx tests/browser-capture.mjs)
//
// Writes JPEGs + a replay log into docs/ui/browser/. Nothing here is used by the app.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSite } from "./browser-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/ui/browser");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-capture-home-"));
process.env.SWARM_HOME = HOME;
process.env.SWARM_BROWSER_HEADLESS = "1";

const { BrowserRuntime, DEFAULT_LIMITS } = await import("../lib/browser/runtime.ts");
const site = await startSite();
const rt = new BrowserRuntime({ ...DEFAULT_LIMITS, maxLive: 4 }, path.join(HOME, "browsers"));
fs.mkdirSync(OUT, { recursive: true });

const write = (name, buf) => {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`wrote docs/ui/browser/${name} (${(buf.length / 1024).toFixed(1)} KB)`);
};

/** Self-contained player: open docs/ui/browser/recording.html to watch the session frame by frame. */
const PLAYER = `<!doctype html><meta charset="utf-8"><title>SwarmAgents browser session replay</title>
<style>body{margin:0;background:#111;color:#eee;font:14px system-ui;padding:16px}img{max-width:100%;border:1px solid #333;border-radius:8px;background:#fff;display:block;min-height:200px}.bar{display:flex;gap:8px;align-items:center;margin:12px 0}button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #555;background:#222;color:#eee;cursor:pointer}input{flex:1}meta{color:#999;font-size:12px}</style>
<div class="bar"><button id="play">Play</button><input id="scrub" type="range" min="0" value="0"><span id="t">&ndash;</span></div>
<img id="frame" alt="first frame">
<meta id="meta">loading&hellip;
<script>
fetch('./recording.jsonl').then(function(r){return r.text();}).then(function(txt){
  var entries = txt.split('\\n').filter(Boolean).map(function(l){return JSON.parse(l);});
  var frames = entries.filter(function(e){return e.kind==='frame';});
  var events = entries.filter(function(e){return e.kind==='event';});
  var img = document.getElementById('frame'), scrub = document.getElementById('scrub'), t = document.getElementById('t');
  document.getElementById('meta').textContent = frames.length + ' frames, ' + events.length + ' events: ' + events.map(function(e){return e.event.type;}).join(', ');
  scrub.max = Math.max(0, frames.length - 1);
  var i = 0, timer = null;
  function show(n){ i = Math.max(0, Math.min(frames.length - 1, n)); var f = frames[i] || {}; img.src = 'data:image/jpeg;base64,' + f.frame;
    scrub.value = i; t.textContent = (i + 1) + '/' + frames.length + ' ' + (f.ts ? new Date(f.ts).toLocaleTimeString() : ''); }
  show(0);
  document.getElementById('play').onclick = function(){
    if (timer) { clearInterval(timer); timer = null; this.textContent = 'Play'; return; }
    this.textContent = 'Pause'; var btn = this;
    timer = setInterval(function(){ if (i >= frames.length - 1) { clearInterval(timer); timer = null; btn.textContent = 'Play'; return; } show(i + 1); }, 400);
  };
  scrub.oninput = function(){ show(Number(scrub.value)); };
});
</script>`;

try {
  const s = rt.acquire("capture-task");
  const page = await s.page();

  // Collect screencast keyframes while the agent works, exactly what the live panel streams.
  const frames = [];
  const off = s.onFrame((f) => frames.push(f));

  await page.goto(site.url + "/modal", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  write("viewer-before-modal.jpg", Buffer.from((frames.at(-1)?.data ?? ""), "base64"));
  await page.click("#open");
  await page.waitForTimeout(300);
  write("viewer-modal-open.jpg", Buffer.from((frames.at(-1)?.data ?? ""), "base64"));
  await page.click("#confirm");
  await page.waitForTimeout(300);
  write("viewer-after-confirm.jpg", Buffer.from((frames.at(-1)?.data ?? ""), "base64"));

  await page.goto(site.url + "/form", { waitUntil: "domcontentloaded" });
  await page.fill("#name", "Jimmy Smith");
  await page.fill("#email", "jimmy@example.test");
  await page.click("#next1");
  await page.waitForTimeout(200);
  write("viewer-multistep-form.jpg", Buffer.from((frames.at(-1)?.data ?? ""), "base64"));

  // The replay log the runtime keeps for the "replay what happened" panel, saved with its frames so
  // the recording can be watched straight from the repo (docs/ui/browser/recording.html).
  const replay = rt.replay("capture-task");
  fs.writeFileSync(path.join(OUT, "recording.jsonl"), replay.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "recording.html"), PLAYER);
  console.log(`wrote docs/ui/browser/recording.jsonl (${replay.length} entries, frames included) + recording.html`);
  console.log(`captured ${frames.length} screencast frames`);
  off();
  await s.close("capture done");
} finally {
  await site.close().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log("\ncapture artifacts written to docs/ui/browser/ (open recording.html to watch)");