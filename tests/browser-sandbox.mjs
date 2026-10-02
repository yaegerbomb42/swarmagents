// Browser on a multi-user server: the launch must drop to the account's uid, keep the profile inside
// the uid-owned workspace, and never share a root between accounts. This locks in the sandbox wiring
// in lib/browser/runtime.ts + lib/sandbox.ts without launching a real Chromium (the wrapper itself is
// exercised in the container).
//
// Run:  npx tsx tests/browser-sandbox.mjs   (npm run test:browser:sandbox)
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-browser-sandbox-"));
process.env.SWARM_HOME = home;
process.env.SWARM_MODE = "server";
process.env.SWARM_SANDBOX = "uid";
process.env.SWARM_CHROMIUM_WRAPPER = "/usr/local/bin/swarm-chromium";

// identity() chowns the account's home to the sandbox uid, which only root can do. Run this suite as
// root (the container); as a normal user there is nothing to assert about the uid split, so skip.
if (process.getuid?.() !== 0) {
  console.log("BROWSER SANDBOX SKIP (not root: uid isolation can only be exercised in the container)");
  process.exit(0);
}

const store = await import("../lib/store.ts");
const users = await import("../lib/users.ts");
const sandbox = await import("../lib/sandbox.ts");
const { runAs } = store;

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log("  ok", name);
};

const A = users.createUser("alice", "pw-alice-pw", false).id;
const B = users.createUser("bob", "pw-bob-pw", false).id;
const uidA = users.osUid(A);
const uidB = users.osUid(B);

t("accounts get distinct sandbox uids", () => {
  assert.notEqual(uidA, uidB);
  assert.ok(uidA >= 20000 && uidB >= 20000, "uids are in the sandbox range");
});

t("chromiumLaunch wraps the browser in the uid switcher for the account", () => {
  runAs(A, () => {
    const l = sandbox.chromiumLaunch();
    assert.equal(l.executablePath, "/usr/local/bin/swarm-chromium", "uses the uid wrapper, never a bare browser");
    assert.equal(l.env.SWARM_RUN_UID, String(uidA), "drops to this account's uid");
    assert.equal(l.env.SWARM_CHROME_REAL, "/usr/bin/chromium", "wrapper execs the real browser");
    assert.equal(l.env.HOME, sandbox.identity().workspace, "HOME is the uid-owned workspace");
    assert.ok(l.profileRoot.startsWith(sandbox.identity().workspace), "profile lives inside the workspace");
  });
});

t("each account's browser root is its own workspace, never shared", () => {
  const rootA = runAs(A, () => path.join(sandbox.identity().workspace, "browsers"));
  const rootB = runAs(B, () => path.join(sandbox.identity().workspace, "browsers"));
  assert.notEqual(rootA, rootB, "roots differ per account");
  assert.ok(rootA.includes(A) && rootB.includes(B), "each root is under its own account home");
});

t("sandboxDir hands a server-made directory to the account's uid", () => {
  runAs(A, () => {
    const dir = path.join(sandbox.identity().workspace, "browsers", "task-1", "profile");
    sandbox.sandboxDir(dir);
    const st = fs.statSync(dir);
    assert.equal(st.uid, uidA, "directory is owned by the account uid");
    assert.equal(st.gid, uidA);
  });
});

t("sandboxDir refuses a path outside the workspace", () => {
  runAs(A, () => {
    assert.throws(() => sandbox.sandboxDir("/etc/swarm-nope"), /outside the workspace/);
  });
});

t("one account cannot read another's browser root", () => {
  const rootB = runAs(B, () => path.join(sandbox.identity().workspace, "browsers"));
  // A's process (uid A) must not be able to enumerate B's root: it sits under B's 0700 home.
  const homeB = path.dirname(path.dirname(rootB)); // <home>
  const mode = (fs.statSync(homeB).mode & 0o777).toString(8);
  assert.ok(mode === "711" || mode === "700", `B's home is private (mode ${mode})`);
});

console.log(`\nBROWSER SANDBOX PASS (${pass})`);