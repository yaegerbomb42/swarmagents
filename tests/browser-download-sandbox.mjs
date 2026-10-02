// Browser downloads on the multi-user server can't be turned against another account (deploy lane, 23:15).
// Real Chromium under the per-account sandbox uid, so this runs as root inside the server image:
//   npm run test:browser:downloads  (tsx)   or, in the container, the esbuild bundle of this file.
// Checks: a normal download lands in the account's own <workspace>/downloads, owned by its uid; a planted
// symlink (downloads -> another account's folder, downloads -> /etc, .browser -> /etc or -> another account)
// fails safely with nothing written or chowned outside; size and type limits hold; server-owned browser
// state stays out of the workspace; one account's browser never sees another's cookies.
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

if (process.getuid?.() !== 0 || process.platform !== "linux") {
  console.log("BROWSER DOWNLOAD SANDBOX SKIP (needs root on Linux: the uid split only exists in the server container)");
  process.exit(0);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-dl-sandbox-"));
process.env.SWARM_HOME = home;
process.env.SWARM_MODE = "server";
process.env.SWARM_SANDBOX = "uid";
process.env.SWARM_BROWSER_SERVER = "on";
process.env.SWARM_BROWSER_HEADLESS = "1";

const store = await import("../lib/store.ts");
const users = await import("../lib/users.ts");
const sandbox = await import("../lib/sandbox.ts");
const { BrowserRuntime, DEFAULT_LIMITS } = await import("../lib/browser/runtime.ts");
const { runAs } = store;

// Local file server: attachments, an oversized file, a blocked type, and a cookie setter.
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/report.txt") return res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=report.txt" }).end("quarterly numbers\n");
  if (u.pathname === "/big.txt") return res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=big.txt" }).end("x".repeat(5000));
  if (u.pathname === "/evil.exe") return res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=evil.exe" }).end("MZ");
  if (u.pathname === "/setcookie") return res.writeHead(200, { "Set-Cookie": "secret=alice-session; Path=/; Max-Age=3600", "Content-Type": "text/html" }).end("<p>set</p>");
  if (u.pathname === "/echo") return res.writeHead(200, { "Content-Type": "text/plain" }).end("cookie=" + (req.headers.cookie ?? ""));
  res.writeHead(200, { "Content-Type": "text/html" }).end("<p>hi</p>");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log("  ok  ", name);
  } catch (e) {
    fail++;
    console.log("  FAIL", name, "-", String(e?.message ?? e).split("\n")[0]);
  }
};

const mk = (n) => users.createUser(n, `pw-${n}-pw-long`, false).id;
const A = mk("alice"), M = mk("mallory"), E = mk("eve");
const uid = (id) => users.osUid(id);
const ws = (id) => runAs(id, () => sandbox.identity().workspace);
const limits = { maxDownloadFileBytes: 1000, maxDownloadBytes: 100_000, maxLive: 8, idleMs: 0, wallMs: 0 };
const rts = new Map();
const rt = (id) => rts.get(id) ?? (rts.set(id, runAs(id, () => new BrowserRuntime({ ...DEFAULT_LIMITS, ...defaults(), ...limits }))), rts.get(id));
function defaults() {
  return { maxTabs: 4, viewport: { width: 800, height: 600 }, downloadTypes: /\.(pdf|txt|csv|json|zip|png)$/i };
}
/** Download `url` as account `id` in session `key`; resolves with the download event. */
const download = (id, key, url) =>
  runAs(id, async () => {
    const s = rt(id).acquire(key);
    s.useWorkspace(ws(id));
    const ev = new Promise((resolve) => {
      const off = s.onEvent((e) => e.type === "download" && (off(), resolve(e)));
      setTimeout(() => resolve({ type: "timeout" }), 30_000);
    });
    const p = await s.page();
    await p.goto(url).catch(() => {});
    return ev;
  });
const owner = (f) => fs.lstatSync(f).uid;
const asUser = (id, f) => fs.lchownSync(f, uid(id), uid(id));

await t("a normal download lands in the account's own downloads, owned by its uid, intact", async () => {
  const e = await download(M, "m1", `${BASE}/report.txt`);
  assert.equal(e.type, "download");
  assert.ok(!e.blocked, `blocked: ${e.blocked}`);
  assert.equal(path.dirname(e.path), fs.realpathSync(path.join(ws(M), "downloads")));
  assert.equal(fs.readFileSync(e.path, "utf8"), "quarterly numbers\n");
  assert.equal(owner(e.path), uid(M), "file owned by the account uid, not root");
  assert.equal(owner(path.join(ws(M), "downloads")), uid(M), "downloads folder made by the uid, not root");
});

await t("server-owned browser state is root-owned and outside the workspace", async () => {
  assert.ok(!fs.existsSync(path.join(ws(M), "browsers")), "no <workspace>/browsers");
  const root = runAs(M, () => path.join(store.userHome(), "browsers"));
  assert.equal(owner(root), 0);
  assert.equal(fs.statSync(root).mode & 0o077, 0, "0700");
});

await t("size limit: an oversized download is refused and nothing is left behind", async () => {
  const e = await download(M, "m1", `${BASE}/big.txt`);
  assert.equal(e.blocked, "size");
  assert.ok(!fs.existsSync(path.join(ws(M), "downloads", "big.txt")));
});

await t("type limit: a disallowed extension is cancelled", async () => {
  const e = await download(M, "m1", `${BASE}/evil.exe`);
  assert.equal(e.blocked, "type");
  assert.ok(!fs.readdirSync(path.join(ws(M), "downloads")).some((f) => f.includes("evil")));
});

await t("ATTACK downloads -> another account's folder: refused, nothing written there", async () => {
  // alice has a downloads folder of her own
  const ad = path.join(ws(A), "downloads");
  fs.mkdirSync(ad, { recursive: true });
  asUser(A, ad);
  const before = fs.readdirSync(ad).length;
  const md = path.join(ws(M), "downloads");
  fs.rmSync(md, { recursive: true, force: true });
  fs.symlinkSync(ad, md);
  asUser(M, md);
  const e = await download(M, "m1", `${BASE}/report.txt`);
  assert.ok(e.blocked, "download must be blocked");
  assert.equal(fs.readdirSync(ad).length, before, "alice's folder unchanged");
  assert.equal(owner(ad), uid(A), "alice's folder still alice's");
  fs.unlinkSync(md);
});

await t("ATTACK downloads -> /etc: refused, nothing created in /etc", async () => {
  const md = path.join(ws(M), "downloads");
  fs.rmSync(md, { recursive: true, force: true });
  fs.symlinkSync("/etc", md);
  asUser(M, md);
  const e = await download(M, "m1", `${BASE}/report.txt`);
  assert.ok(e.blocked, "download must be blocked");
  assert.ok(!fs.existsSync("/etc/report.txt"));
  assert.equal(owner("/etc"), 0, "/etc still root's");
  fs.unlinkSync(md);
});

await t("ATTACK .browser -> /etc before launch: launch refused, /etc not chowned", async () => {
  const b = path.join(ws(E), ".browser");
  fs.symlinkSync("/etc", b);
  asUser(E, b);
  await assert.rejects(runAs(E, () => rt(E).acquire("e1").page()), /link or points outside/);
  assert.equal(owner("/etc"), 0);
  assert.ok(!fs.readdirSync("/etc").some((f) => f.startsWith("e1-")), "no profile dir created in /etc");
  fs.unlinkSync(b);
});

await t("ATTACK .browser -> another account's workspace: launch refused, alice's folder untouched", async () => {
  const b = path.join(ws(E), ".browser");
  fs.symlinkSync(ws(A), b);
  asUser(E, b);
  await assert.rejects(runAs(E, () => rt(E).acquire("e2").page()), /link or points outside/);
  assert.equal(owner(ws(A)), uid(A));
  assert.ok(!fs.readdirSync(ws(A)).some((f) => f.startsWith("e2-")));
  fs.unlinkSync(b);
});

await t("cookie isolation: mallory's browser never sees alice's cookies", async () => {
  await runAs(A, async () => {
    const p = await rt(A).acquire("a1").page();
    await p.goto(`${BASE}/setcookie`);
    await p.goto(`${BASE}/echo`);
    assert.match(await p.innerText("body"), /secret=alice-session/, "alice's own cookie works");
  });
  await runAs(M, async () => {
    const p = await rt(M).acquire("m2").page();
    await p.goto(`${BASE}/echo`);
    assert.doesNotMatch(await p.innerText("body"), /alice-session/);
    const all = await p.context().cookies();
    assert.ok(!all.some((c) => c.value === "alice-session"));
  });
});

await t("chromium processes run as the account uid, never root", async () => {
  const procs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  const chrome = [];
  for (const pid of procs) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (/chrom/i.test(cmd.split("\0")[0]) && !/swarm-chromium|setpriv/.test(cmd.split("\0")[0])) chrome.push(fs.statSync(`/proc/${pid}`).uid);
    } catch {}
  }
  assert.ok(chrome.length > 0, "found chromium processes");
  assert.ok(chrome.every((u) => u >= 20000), `chromium uids: ${[...new Set(chrome)].join(",")}`);
});

const chromiumPids = () =>
  fs.readdirSync("/proc").filter((d) => {
    try {
      return /^\d+$/.test(d) && /chrom/i.test(fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0")[0]) && !/^Z/m.test(fs.readFileSync(`/proc/${d}/status`, "utf8").match(/^State:\s+(\S)/m)?.[1] ?? "");
    } catch {
      return false;
    }
  });
await t("closing sessions stops every chromium process (works without CAP_KILL: graceful close as the uid)", async () => {
  for (const [id, r] of rts) await runAs(id, async () => { for (const s of r.list()) await r.release(s.key); });
  for (let i = 0; i < 20 && chromiumPids().length; i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(chromiumPids().length, 0, `left running: ${chromiumPids().length}`);
});
srv.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`\nbrowser download sandbox: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
