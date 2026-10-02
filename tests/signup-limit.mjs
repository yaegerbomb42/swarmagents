// Sign-up cap (lib/tenant/signup-limit.ts): per-IP and global caps hold, survive a restart (persisted in
// $SWARM_HOME/signup-limit.db, 0600, hashed IPs only) and expire after an hour. Run: node tests/signup-limit.mjs
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "signup-limit-home-"));
const out = path.join(home, "signup-limit.bundle.mjs");
process.env.SWARM_HOME = home;
await build({ entryPoints: [path.join(root, "lib/tenant/signup-limit.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const fail = (m) => { console.log("FAIL", m); process.exitCode = 1; };
let m = await import(out + "?a");
const now = Date.now();
for (let i = 0; i < 5; i++) { if (m.signupBlocked("1.2.3.4", now)) fail("blocked early " + i); m.noteSignup("1.2.3.4", now); }
if (!m.signupBlocked("1.2.3.4", now)) fail("6th not blocked"); else console.log("ok 6th from same ip blocked");
if (m.signupBlocked("5.6.7.8", now)) fail("other ip blocked"); else console.log("ok other ip allowed");
// simulate restart: new module instance + drop the cached handle
delete globalThis.__swarmSignupDb;
m = await import(out + "?b");
if (!m.signupBlocked("1.2.3.4", now + 1000)) fail("restart reset the cap"); else console.log("ok cap survives restart");
const mode = (fs.statSync(home + "/signup-limit.db").mode & 0o777).toString(8);
mode === "600" ? console.log("ok db mode 600") : fail("mode " + mode);
const raw = fs.readFileSync(home + "/signup-limit.db");
raw.includes("1.2.3.4") ? fail("raw ip stored") : console.log("ok no raw ip in db");
process.env.SWARM_SIGNUP_PER_HOUR = "7";
for (let i = 0; i < 2; i++) m.noteSignup("9.9.9." + i, now + 2000);
m.signupBlocked("10.0.0.1", now + 3000) ? console.log("ok global cap") : fail("global cap");
if (m.signupBlocked("1.2.3.4", now + 3600001)) fail("not expired"); else console.log("ok window expires after an hour");
fs.rmSync(home, { recursive: true, force: true });
if (!process.exitCode) console.log("\nsignup limit: all checks passed");
