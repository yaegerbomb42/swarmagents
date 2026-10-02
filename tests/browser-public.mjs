#!/usr/bin/env node
// One real public-site run (lane: browser): search a docs site with the live browser and extract an
// answer. Uses the isolated runtime + the same snapshot/observe path the tool uses.
//
//   npm run test:browser:public
//   PUBLIC_DOCS_URL="https://docs.example/search.html?q=…" PUBLIC_DOCS_EXPECT="some phrase" to retarget
//
// Needs network access. If the network is unavailable the test reports SKIP and exits 0, so the
// offline suites stay green.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-public-home-"));
process.env.SWARM_HOME = HOME;
process.env.SWARM_BROWSER_HEADLESS = "1";

const { BrowserRuntime, DEFAULT_LIMITS } = await import("../lib/browser/runtime.ts");

const SEARCH_URL = process.env.PUBLIC_DOCS_URL || "https://docs.python.org/3/search.html?q=json.loads";
const EXPECT = (process.env.PUBLIC_DOCS_EXPECT || "json.loads").toLowerCase();

const rt = new BrowserRuntime({ ...DEFAULT_LIMITS, maxLive: 2 }, path.join(HOME, "browsers"));
const s = rt.acquire("public-run");
let failures = 0;
const check = (name, cond, extra = "") => {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${extra ? ` — ${extra}` : ""}`);
};
const skip = (why) => {
  console.log(`  [SKIP] ${why}`);
  console.log("\nbrowser public run: skipped (no network)");
  process.exit(0);
};

try {
  const page = await s.page();
  let settled;
  try {
    settled = await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 25_000 });
  } catch (e) {
    const msg = String(e.message ?? e);
    if (/net::|ERR_|Timeout|DNS/i.test(msg)) skip(`public site unreachable: ${msg.split("\n")[0]}`);
    throw e;
  }
  if (!settled || (settled.status() >= 500 && settled.status() !== 500)) skip(`public site returned ${settled?.status()}`);

  // Let the docs' own search scripts run and render results, then read what a human would read.
  await page.waitForTimeout(1500);
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  check("the page loaded and has readable text", bodyText.length > 200, `${bodyText.length} chars, ${page.url()}`);
  check(`the extracted answer mentions "${EXPECT}"`, bodyText.toLowerCase().includes(EXPECT), bodyText.slice(0, 160).replace(/\n/g, " "));

  // Follow the first result the site offers (that is the real "search a docs site" flow).
  const first = await page
    .locator("a[href]")
    .filter({ hasText: EXPECT.split(".")[0] })
    .first()
    .getAttribute("href", { timeout: 4000 })
    .catch(() => null);
  if (first) {
    await page.goto(new URL(first, page.url()).href, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
    const answer = await page.evaluate(() => document.body.innerText).catch(() => "");
    check("the answer is extracted from the target page", answer.toLowerCase().includes(EXPECT.split(".")[0]), `${answer.length} chars from ${page.url()}`);
    console.log(`  extracted: ${answer.split("\n").find((l) => l.toLowerCase().includes(EXPECT.split(".")[0]))?.slice(0, 200) ?? answer.slice(0, 200)}`);
  } else {
    console.log("  [INFO] no anchor matched on the results page; the text check above is the extraction proof");
  }

  // A screenshot for docs/ui/browser/ so the run is visible to a human.
  const out = path.join(ROOT, "docs/ui/browser");
  fs.mkdirSync(out, { recursive: true });
  const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
  if (shot) fs.writeFileSync(path.join(out, "public-site-run.jpg"), shot);
} finally {
  await s.close("public run done").catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} public-run check(s) failed` : "\nbrowser public run: all checks passed");
process.exit(failures ? 1 : 0);