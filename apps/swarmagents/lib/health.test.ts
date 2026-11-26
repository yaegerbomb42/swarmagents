import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepHealthSnapshot, healthSnapshot } from "./health";
import { configureStorePaths } from "./board/store";
import { CONNECTOR_CATALOG } from "./connectors/catalog";
import { CONNECTORS } from "./library/catalog";
import { PROVIDER_CATALOG } from "./providers/catalog";
import { configureProviderStorePaths, saveProvider } from "./providers/store";

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-health-")));
}

// Every env var lib/health.ts reads for the host-env provider count. A dev
// machine or CI runner may export any of these (e.g. SWARM_KEYS_OPENAI), so
// each case must start from a clean slate and get its original values back.
const HOST_KEY_VARS = [...new Set(PROVIDER_CATALOG.map((entry) => entry.envVar))];

function stashHostKeyVars(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of HOST_KEY_VARS) saved[name] = process.env[name];
  for (const name of HOST_KEY_VARS) delete process.env[name];
  return saved;
}

function restoreHostKeyVars(saved: Record<string, string | undefined>): void {
  for (const name of HOST_KEY_VARS) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

let savedHostKeyVars: Record<string, string | undefined>;

beforeEach(() => {
  savedHostKeyVars = stashHostKeyVars();
});

afterEach(() => {
  restoreHostKeyVars(savedHostKeyVars);
});

test("health snapshot exposes only the agreed fields, never secrets", () => {
  process.env.SWARM_KEYS_ANTHROPIC = "sk-test-anthropic";
  const snap = healthSnapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    "atlasReady",
    "board",
    "builtAt",
    "catalogConnectorCount",
    "commit",
    "desktopEnabled",
    "ok",
    "providersConfigured",
    "providersScope",
    "toolForgeReady",
    "uptimeSec",
    "version",
    "vmDriver",
  ]);
  assert.equal(typeof snap.ok, "boolean");
  assert.equal(snap.version, "2.0.0");
  assert.ok(snap.uptimeSec >= 0);
  assert.equal(snap.providersConfigured, 1);
  assert.equal(snap.providersScope, "host-env");
  // The raw key value must never leak into the report.
  assert.equal(JSON.stringify(snap).includes("sk-test-anthropic"), false);
});

test("commit and builtAt come from env or fall back to defaults", () => {
  const prevSha = process.env.SWARM_GIT_SHA;
  const prevBuilt = process.env.SWARM_BUILD_TIME;
  try {
    delete process.env.SWARM_GIT_SHA;
    delete process.env.SWARM_BUILD_TIME;
    let snap = healthSnapshot();
    assert.equal(snap.commit, "unknown");
    assert.equal(snap.builtAt, null);

    process.env.SWARM_GIT_SHA = "abc123def";
    process.env.SWARM_BUILD_TIME = "2026-11-11T00:00:00Z";
    snap = healthSnapshot();
    assert.equal(snap.commit, "abc123def");
    assert.equal(snap.builtAt, "2026-11-11T00:00:00Z");

    process.env.SWARM_GIT_SHA = "  ";
    process.env.SWARM_BUILD_TIME = "  ";
    snap = healthSnapshot();
    assert.equal(snap.commit, "unknown");
    assert.equal(snap.builtAt, null);
  } finally {
    if (prevSha !== undefined) process.env.SWARM_GIT_SHA = prevSha;
    else delete process.env.SWARM_GIT_SHA;
    if (prevBuilt !== undefined) process.env.SWARM_BUILD_TIME = prevBuilt;
    else delete process.env.SWARM_BUILD_TIME;
  }
});

test("an unparseable SWARM_BUILD_TIME reports builtAt null instead of garbage", () => {
  const prevBuilt = process.env.SWARM_BUILD_TIME;
  try {
    process.env.SWARM_BUILD_TIME = "not-a-date";
    assert.equal(healthSnapshot().builtAt, null);
  } finally {
    if (prevBuilt !== undefined) process.env.SWARM_BUILD_TIME = prevBuilt;
    else delete process.env.SWARM_BUILD_TIME;
  }
});

test("builtAt is an ISO string when SWARM_BUILD_TIME is set", () => {
  const prevBuilt = process.env.SWARM_BUILD_TIME;
  try {
    process.env.SWARM_BUILD_TIME = "2026-11-12T14:00:00.000Z";
    const snap = healthSnapshot();
    assert.equal(typeof snap.builtAt, "string");
    assert.equal(snap.builtAt, "2026-11-12T14:00:00.000Z");
    assert.ok(!Number.isNaN(Date.parse(snap.builtAt as string)));
  } finally {
    if (prevBuilt !== undefined) process.env.SWARM_BUILD_TIME = prevBuilt;
    else delete process.env.SWARM_BUILD_TIME;
  }
});

test("providersConfigured counts host provider keys from the catalog (SWARM_KEYS_*)", () => {
  const prevStdA = process.env.ANTHROPIC_API_KEY;
  const prevStdO = process.env.OPENAI_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.equal(healthSnapshot().providersConfigured, 0);

    // The VPS case: only the NVIDIA host key is set — it must count.
    process.env.SWARM_KEYS_NVIDIA_NIM = "nvapi-fake-host-key";
    assert.equal(healthSnapshot().providersConfigured, 1);

    process.env.SWARM_KEYS_ANTHROPIC = "sk-fake-host-anthropic";
    assert.equal(healthSnapshot().providersConfigured, 2);
    process.env.SWARM_KEYS_OPENAI = "  ";
    assert.equal(healthSnapshot().providersConfigured, 2, "whitespace-only is not a key");
    delete process.env.SWARM_KEYS_NVIDIA_NIM;
    delete process.env.SWARM_KEYS_ANTHROPIC;
    assert.equal(healthSnapshot().providersConfigured, 0);

    // Deliberate: a provider's standard env var (e.g. ANTHROPIC_API_KEY) does
    // NOT count — the runtime never reads it, only SWARM_KEYS_*.
    process.env.ANTHROPIC_API_KEY = "sk-fake-standard-anthropic";
    process.env.OPENAI_API_KEY = "sk-fake-standard-openai";
    assert.equal(healthSnapshot().providersConfigured, 0);
  } finally {
    if (prevStdA !== undefined) process.env.ANTHROPIC_API_KEY = prevStdA;
    else delete process.env.ANTHROPIC_API_KEY;
    if (prevStdO !== undefined) process.env.OPENAI_API_KEY = prevStdO;
    else delete process.env.OPENAI_API_KEY;
  }
});

test("providersConfigured counts a signed-in user's BYOK providers, never their keys", () => {
  const USER = "local_alice@example.com";
  const KEY = "nvapi-fake-user-key-0123456789";
  const dir = tmpDir();
  const prevHome = process.env.SWARM_HOME;
  try {
    configureStorePaths(dir, path.join(dir, "swarm_board.json"));
    configureProviderStorePaths(path.join(dir, "providers.json"));
    // No saved providers: a signed-in user with nothing saved reports 0.
    assert.equal(healthSnapshot({ NODE_ENV: "test" }, USER).providersConfigured, 0);

    saveProvider(USER, { id: "nvidia-nim", apiKey: KEY });
    const snap = healthSnapshot({ NODE_ENV: "test" }, USER);
    assert.equal(snap.providersScope, "user");
    assert.equal(snap.providersConfigured, 1);
    // The count only: no key material and no provider id leaks into the report.
    assert.equal(JSON.stringify(snap).includes(KEY), false);
    assert.equal(JSON.stringify(snap).includes("nvidia-nim"), false);

    // Another user with nothing saved still reports 0 (no cross-account leak).
    assert.equal(healthSnapshot({ NODE_ENV: "test" }, "local_bob@example.com").providersConfigured, 0);
  } finally {
    if (prevHome !== undefined) process.env.SWARM_HOME = prevHome;
    configureProviderStorePaths("");
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
  }
});

test("vmDriver reports the explicit driver or the environment default", () => {
  const prev = process.env.SWARM_VM_DRIVER;
  try {
    delete process.env.SWARM_VM_DRIVER;
    assert.equal(healthSnapshot({ NODE_ENV: "development" }).vmDriver, "fake");
    assert.equal(healthSnapshot({ NODE_ENV: "production" }).vmDriver, "docker");
    process.env.SWARM_VM_DRIVER = "docker";
    assert.equal(healthSnapshot().vmDriver, "docker");
    process.env.SWARM_VM_DRIVER = "  ";
    assert.equal(healthSnapshot({ NODE_ENV: "development" }).vmDriver, "fake");
  } finally {
    if (prev !== undefined) process.env.SWARM_VM_DRIVER = prev;
    else delete process.env.SWARM_VM_DRIVER;
  }
});

test("board.writable is true for a writable directory and false for an unusable path", () => {
  const dir = tmpDir();
  const prevHome = process.env.SWARM_HOME;
  try {
    configureStorePaths(dir, path.join(dir, "swarm_board.json"));
    let snap = healthSnapshot();
    assert.equal(snap.board.writable, true);
    assert.equal(snap.ok, true);

    // A file where the storage directory must live: not writable, ok flips false.
    const blocked = path.join(tmpDir(), "not-a-dir");
    fs.writeFileSync(blocked, "x");
    configureStorePaths(blocked, path.join(blocked, "swarm_board.json"));
    snap = healthSnapshot();
    assert.equal(snap.board.writable, false);
    assert.equal(snap.ok, false);
  } finally {
    if (prevHome !== undefined) process.env.SWARM_HOME = prevHome;
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
  }
});

test("board.writable stays true before first boot when the parent is writable", () => {
  const dir = tmpDir();
  const missing = path.join(dir, "does-not-exist-yet");
  configureStorePaths(missing, path.join(missing, "swarm_board.json"));
  assert.equal(healthSnapshot().board.writable, true);
  configureStorePaths(
    process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
    path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
  );
});

test("deepHealthSnapshot exposes non-secret subsystem diagnostics", () => {
  process.env.SWARM_KEYS_ANTHROPIC = "sk-test-anthropic-secret";
  try {
    const deep = deepHealthSnapshot();
    assert.equal(deep.subsystems.toolForgeReady, true);
    assert.equal(deep.subsystems.atlasReady, true);
    assert.ok(deep.subsystems.catalogConnectorCount >= 40);
    assert.equal(typeof deep.subsystems.desktopEnabled, "boolean");
    assert.equal(JSON.stringify(deep).includes("sk-test-anthropic-secret"), false);
  } finally {
    delete process.env.SWARM_KEYS_ANTHROPIC;
  }
});
test("subsystem checks default to off, with counts from the catalogs", () => {
  // Explicit env so a stray SWARM_* var in the test runner cannot flip a flag.
  const snap = healthSnapshot({ NODE_ENV: "test" });
  assert.equal(snap.desktopEnabled, false);
  assert.equal(snap.atlasReady, false);
  assert.equal(snap.catalogConnectorCount, CONNECTOR_CATALOG.length);
  assert.ok(CONNECTOR_CATALOG.length > 0, "connector catalog is non-empty");
  assert.equal(snap.toolForgeReady, CONNECTORS.length > 0);
  assert.ok(CONNECTORS.length > 0, "MCP tool library is non-empty");
  // Booleans and counts only: no key material, provider names, or paths.
  assert.equal(typeof snap.desktopEnabled, "boolean");
  assert.equal(typeof snap.atlasReady, "boolean");
  assert.equal(typeof snap.toolForgeReady, "boolean");
  assert.equal(typeof snap.catalogConnectorCount, "number");
});

test("desktopEnabled follows SWARM_VM_DESKTOP", () => {
  assert.equal(healthSnapshot({ NODE_ENV: "test", SWARM_VM_DESKTOP: "1" }).desktopEnabled, true);
  assert.equal(healthSnapshot({ NODE_ENV: "test", SWARM_VM_DESKTOP: "0" }).desktopEnabled, false);
  assert.equal(healthSnapshot({ NODE_ENV: "test", SWARM_VM_DESKTOP: "yes" }).desktopEnabled, false);
  assert.equal(healthSnapshot({ NODE_ENV: "test" }).desktopEnabled, false);
});

test("atlasReady follows SWARM_ATLAS_ENABLED", () => {
  assert.equal(healthSnapshot({ NODE_ENV: "test", SWARM_ATLAS_ENABLED: "1" }).atlasReady, true);
  assert.equal(healthSnapshot({ NODE_ENV: "test", SWARM_ATLAS_ENABLED: "0" }).atlasReady, false);
  assert.equal(healthSnapshot({ NODE_ENV: "test" }).atlasReady, false);
});

test("subsystem fields never leak env values, even with keys set", () => {
  const snap = healthSnapshot({
    NODE_ENV: "test",
    SWARM_VM_DESKTOP: "1",
    SWARM_ATLAS_ENABLED: "1",
    SWARM_KEYS_ANTHROPIC: "sk-test-subsystem-secret",
  });
  assert.equal(snap.desktopEnabled, true);
  assert.equal(snap.atlasReady, true);
  const serialized = JSON.stringify(snap);
  assert.equal(serialized.includes("sk-test-subsystem-secret"), false);
  assert.equal(serialized.includes("SWARM_KEYS_ANTHROPIC"), false);
  assert.equal(serialized.includes("SWARM_VM_DESKTOP"), false);
  assert.equal(serialized.includes("SWARM_ATLAS_ENABLED"), false);
});
