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

  // The replay log the runtime keeps for the "replay what happened" panel.
  const replay = rt.replay("capture-task");
  fs.writeFileSync(path.join(OUT, "session-replay.jsonl"), replay.map((e) => JSON.stringify({ ...e, frame: e.frame ? `[${e.frame.length} bytes]` : undefined })).join("\n") + "\n");
  console.log(`wrote docs/ui/browser/session-replay.jsonl (${replay.length} entries)`);
  console.log(`captured ${frames.length} screencast frames`);
  off();
  await s.close("capture done");
} finally {
  await site.close().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}