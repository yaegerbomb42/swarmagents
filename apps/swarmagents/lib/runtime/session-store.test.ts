import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureSessionPaths,
  getSessionStorePath,
  loadSessionStore,
  saveSessionAtomic,
  getLastSession,
  setLastSession,
  clearLastSession,
  isForbiddenUserId,
} from "./session-store";
import { configureStorePaths } from "../board/store";

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-session-")));
}

function plainObject(value: object): Record<string, unknown> {
  return { ...value };
}

test("roundtrip: load, set, get, clear", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_test.json"));

  try {
    assert.equal(getLastSession("alice"), undefined);

    await setLastSession("alice", "sess_123");
    assert.equal(getLastSession("alice"), "sess_123");

    await setLastSession("bob", "sess_456");
    assert.equal(getLastSession("alice"), "sess_123");
    assert.equal(getLastSession("bob"), "sess_456");

    await clearLastSession("alice");
    assert.equal(getLastSession("alice"), undefined);
    assert.equal(getLastSession("bob"), "sess_456");
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

test("atomic write temp names carry a random component (same-ms collision)", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_tmp.json"));

  // Capture the temp paths the atomic write actually uses.
  const tmpNames: string[] = [];
  const realWriteFile = fs.promises.writeFile;
  (fs.promises as unknown as Record<string, unknown>).writeFile = async (
    file: string | Buffer | URL,
    ...args: unknown[]
  ) => {
    tmpNames.push(String(file));
    return (realWriteFile as (...a: unknown[]) => Promise<void>)(file, ...args);
  };
  try {
    // Two saves back to back (very likely the same millisecond): with only
    // pid+ms in the name they would collide on one temp file.
    await saveSessionAtomic({ user1: "sess_a" });
    await saveSessionAtomic({ user1: "sess_b", user2: "sess_c" });
    assert.equal(tmpNames.length, 2);
    assert.notEqual(tmpNames[0], tmpNames[1]);
    for (const tmp of tmpNames) {
      assert.match(tmp, /\.tmp\.\d+\.\d+\.[0-9a-f-]{36}$/, `temp name must end in a UUID: ${tmp}`);
    }
    assert.deepEqual(plainObject(loadSessionStore()), { user1: "sess_b", user2: "sess_c" });
  } finally {
    (fs.promises as unknown as Record<string, unknown>).writeFile = realWriteFile;
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

test("atomic write creates temp then renames", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_atomic.json"));

  try {
    await saveSessionAtomic({ user1: "sess_a" });
    const store = loadSessionStore();
    assert.deepEqual(plainObject(store), { user1: "sess_a" });
    // No temp files should remain
    const files = fs.readdirSync(dir);
    assert.equal(files.some((f) => f.includes(".tmp.")), false);
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

test("malformed store file is handled gracefully", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_malformed.json"));

  try {
    fs.writeFileSync(getSessionStorePath(), "not json", "utf-8");
    const store = loadSessionStore();
    assert.deepEqual(plainObject(store), {});
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

test("non-object JSON falls back to empty store", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_array.json"));

  try {
    fs.writeFileSync(getSessionStorePath(), JSON.stringify(["a", "b"]), "utf-8");
    const store = loadSessionStore();
    assert.deepEqual(plainObject(store), {});
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

test("store uses null-prototype object", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_proto.json"));

  try {
    await setLastSession("alice", "sess_1");
    const store = loadSessionStore();
    assert.equal(Object.getPrototypeOf(store), null);
    assert.equal(getLastSession("alice"), "sess_1");
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

for (const forbidden of ["__proto__", "constructor", "prototype"]) {
  test(`rejects forbidden userId: ${forbidden}`, async () => {
    const dir = tmpDir();
    configureStorePaths(dir, path.join(dir, "board.json"));
    configureSessionPaths(path.join(dir, `session_reject_${forbidden}.json`));

    try {
      assert.equal(isForbiddenUserId(forbidden), true);
      await setLastSession("alice", "sess_ok");
      await assert.rejects(setLastSession(forbidden, "sess_evil"), (err: Error) =>
        err.message.includes("forbidden userId"),
      );
      assert.equal(getLastSession(forbidden), undefined);
      assert.equal(getLastSession("alice"), "sess_ok");
      await clearLastSession(forbidden);

      const raw = JSON.parse(fs.readFileSync(getSessionStorePath(), "utf-8"));
      assert.deepEqual(plainObject(raw), { alice: "sess_ok" });
      assert.equal(Object.hasOwn(raw, forbidden), false);
    } finally {
      configureStorePaths(
        process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
        path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
      );
      configureSessionPaths("");
    }
  });
}

test("rejected keys on disk are filtered out on load", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_filter.json"));

  try {
    fs.writeFileSync(
      getSessionStorePath(),
      JSON.stringify({ user1: "sess_a", __proto__: "sess_evil", constructor: "sess_evil", prototype: "sess_evil" }),
      "utf-8",
    );
    const store = loadSessionStore();
    assert.deepEqual(plainObject(store), { user1: "sess_a" });
    assert.equal(getLastSession("user1"), "sess_a");
    assert.equal(getLastSession("__proto__"), undefined);
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

test("JSON file format is preserved across round-trip", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_format.json"));

  try {
    await setLastSession("alice", "sess_1");
    await setLastSession("bob", "sess_2");
    const raw = fs.readFileSync(getSessionStorePath(), "utf-8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(plainObject(parsed), { alice: "sess_1", bob: "sess_2" });
    assert.equal(getLastSession("alice"), "sess_1");
    assert.equal(getLastSession("bob"), "sess_2");
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});

test("concurrent writes for different users do not lose updates", async () => {
  const dir = tmpDir();
  configureStorePaths(dir, path.join(dir, "board.json"));
  configureSessionPaths(path.join(dir, "session_concurrent.json"));

  try {
    await Promise.all([
      setLastSession("alice", "sess_a"),
      setLastSession("bob", "sess_b"),
      setLastSession("carol", "sess_c"),
      clearLastSession("bob"),
    ]);
    assert.equal(getLastSession("alice"), "sess_a");
    assert.equal(getLastSession("carol"), "sess_c");
    assert.equal(getLastSession("bob"), undefined);
  } finally {
    configureStorePaths(
      process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"),
      path.join(process.env.SWARM_HOME || path.join(os.homedir(), ".swarmagents"), "swarm_board.json"),
    );
    configureSessionPaths("");
  }
});
