// Sign-up captcha (lib/tenant/captcha.ts, ALTCHA PoW): a missing, malformed or tampered solution is refused, a valid
// one passes once, a replay fails, and the HMAC key is a 0600 file generated outside the source tree.
// Run: node tests/signup-captcha.mjs   (the HTTP 400/200/replay path is covered by host/swarmagents-tenant-probe.sh)
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "signup-captcha-home-"));
process.env.SWARM_HOME = home;
process.env.SWARM_ALTCHA_COST = "200";
process.env.SWARM_ALTCHA_MAX_COUNTER = "300";
const out = path.join(home, "captcha.bundle.mjs");
fs.writeFileSync(
  path.join(home, "entry.ts"),
  `export * from ${JSON.stringify(path.join(root, "lib/tenant/captcha.ts"))};\nexport { solveChallenge } from "altcha-lib";\nexport { deriveKey } from "altcha-lib/algorithms/pbkdf2";\n`,
);
await build({ entryPoints: [path.join(home, "entry.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error", nodePaths: [path.join(root, "node_modules")] });
const m = await import(out);

let failed = 0;
const ok = (cond, name) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failed++;
};
const solve = async () => {
  const challenge = await m.signupChallenge();
  const s = await m.solveChallenge({ challenge, deriveKey: m.deriveKey });
  return { challenge, payload: Buffer.from(JSON.stringify({ challenge, solution: s })).toString("base64") };
};

ok((await m.signupCaptchaError(undefined)) !== null, "missing solution is refused");
ok((await m.signupCaptchaError("not-base64-json")) !== null, "malformed solution is refused");
const { challenge, payload } = await solve();
const bad = JSON.parse(Buffer.from(payload, "base64").toString());
// The derived key is the proof of work (its HMAC is signed into the challenge); a guessed one must fail.
bad.solution.derivedKey = bad.solution.derivedKey.slice(0, -1) + (bad.solution.derivedKey.endsWith("0") ? "1" : "0");
ok((await m.signupCaptchaError(Buffer.from(JSON.stringify(bad)).toString("base64"))) !== null, "a wrong (unworked) solution is refused");
const forged = JSON.parse(Buffer.from(payload, "base64").toString());
forged.challenge.parameters.expiresAt += 86_400;
ok((await m.signupCaptchaError(Buffer.from(JSON.stringify(forged)).toString("base64"))) !== null, "tampered (re-dated) challenge is refused");
const fresh = await solve();
ok((await m.signupCaptchaError(fresh.payload)) === null, "a valid solution passes");
ok(/already used/.test((await m.signupCaptchaError(fresh.payload)) ?? ""), "replaying the same solution fails");
ok(typeof challenge.signature === "string" && challenge.parameters.expiresAt > Date.now() / 1000, "challenges are signed and expire");
const keyFile = path.join(home, "altcha-hmac.key");
ok(fs.existsSync(keyFile) && (fs.statSync(keyFile).mode & 0o777) === 0o600, "HMAC key generated as a 0600 file in SWARM_HOME");
ok(!fs.readFileSync(out, "utf8").includes(fs.readFileSync(keyFile, "utf8").trim()), "the key is not in the code");
process.env.SWARM_SIGNUP_CAPTCHA = "off";
ok((await m.signupCaptchaError(undefined)) === null, "SWARM_SIGNUP_CAPTCHA=off disables it (test containers)");
fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\nsignup captcha: ${failed} FAILED` : "\nsignup captcha: all checks passed");
process.exit(failed ? 1 : 0);
