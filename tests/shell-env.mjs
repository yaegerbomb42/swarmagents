// shell child-env scrub test: mirrors childEnv() in lib/tools/shell.ts and proves a real child process
// can't see server-only secrets. Run: node tests/shell-env.mjs
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// --- mirror of lib/tools/shell.ts childEnv() ---
const STRIPPED_ENV = new Set(["SWARM_AUTH_TOKEN", "SWARM_AUTH_TOKEN_SHA256"]);
function childEnv(process_env) {
  const env = {
    NODE_ENV: process_env.NODE_ENV ?? "production",
    TERM: "dumb",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
  };
  for (const [k, v] of Object.entries(process_env)) {
    if (k in env) continue;
    if (k === "SWARM_HOME") {
      if (v !== undefined) env[k] = v;
      continue;
    }
    if (STRIPPED_ENV.has(k) || k.startsWith("SWARM_")) continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

// 1. Logic: server-only keys stripped, SWARM_HOME + normal env preserved.
{
  const src = {
    SWARM_AUTH_TOKEN: "owner-secret",
    SWARM_AUTH_TOKEN_SHA256: "abc123",
    SWARM_BROWSER_HEADLESS: "1",
    SWARM_HOME: "/tmp/swarm-home",
    PATH: "/usr/bin:/bin",
    HOME: "/Users/x",
    LANG: "en_US.UTF-8",
  };
  const env = childEnv(src);
  assert.equal(env.SWARM_AUTH_TOKEN, undefined, "owner token must not reach children");
  assert.equal(env.SWARM_AUTH_TOKEN_SHA256, undefined, "token hash must not reach children");
  assert.equal(env.SWARM_BROWSER_HEADLESS, undefined, "all SWARM_* are server config");
  assert.equal(env.SWARM_HOME, "/tmp/swarm-home", "SWARM_HOME must survive (session data dir)");
  assert.equal(env.PATH, "/usr/bin:/bin", "PATH must survive or bash breaks");
  assert.equal(env.HOME, "/Users/x", "HOME must survive");
  assert.equal(env.TERM, "dumb", "TERM default applied");
  assert.equal(env.NODE_ENV, "production", "NODE_ENV default applied");
}
// 2. Real spawn: a child zsh cannot read the secret from its environment.
{
  const env = childEnv({ ...process.env, SWARM_AUTH_TOKEN: "owner-secret", SWARM_HOME: process.env.SWARM_HOME ?? "/tmp/swarm-home" });
  const r = spawnSync("/bin/zsh", ["-lc", "printenv SWARM_AUTH_TOKEN || echo ABSENT; echo PATH_OK=$([ -n \"$PATH\" ] && echo yes)"], {
    env,
    encoding: "utf8",
  });
  assert.ok(r.stdout.includes("ABSENT"), `child should not see SWARM_AUTH_TOKEN, got: ${r.stdout}`);
  assert.ok(!r.stdout.includes("owner-secret"), "child must never print the secret");
  assert.ok(r.stdout.includes("PATH_OK=yes"), "child must keep a usable PATH");
}
// 3. No SWARM_* key of any name leaks (guards future additions).
{
  const weird = { SWARM_FUTURE_SECRET: "x", SWARM_DB_PASSWORD: "y", SWARM_HOME: "/tmp/h" };
  const env = childEnv(weird);
  const leaked = Object.keys(env).filter((k) => k.startsWith("SWARM_") && k !== "SWARM_HOME");
  assert.deepEqual(leaked, [], `only SWARM_HOME may pass through, leaked: ${leaked.join(",")}`);
}
console.log("shell-env: 3/3 pass");