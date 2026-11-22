import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  BoardUnavailableError,
  configureStorePaths,
  getStorageHealth,
  isDirWritable,
  loadStore,
  saveStoreAtomic,
  withLockedStore,
} from "./store";
import { handleClaimTask, handleCreateTask, handleSyncArtifact } from "./handlers";
import type { BoardStore } from "./types";

function emptyStore(): BoardStore {
  return { tasks: [], proposals: [], messages: [], leaderboard: [], matches: [] };
}

function seededStore(): BoardStore {
  const store = emptyStore();
  store.tasks.push({
    id: "t1",
    title: "Keep me",
    description: "valid work",
    difficulty: "easy",
    constraints: [],
    status: "open",
    createdAt: 1,
    updatedAt: 1,
  });
  return store;
}

function tmpDir(prefix = "swarm-store-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Swap fs.readFileSync for the duration of one test, restoring it after. */
function mockReadFileSync(fn: (real: typeof fs.readFileSync) => typeof fs.readFileSync): () => void {
  const real = fs.readFileSync;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = fn(real);
  return () => {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = real;
  };
}

function ioError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// Root ignores Unix permission bits, so the read-only assertions only hold as
// a non-root user; skip them under root instead of asserting a false failure.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("isDirWritable returns true for a writable temp dir", () => {
  const dir = tmpDir();
  try {
    assert.equal(isDirWritable(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getStorageHealth reflects the configured storage path", () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  configureStorePaths(dir, dataFile);
  try {
    const health = getStorageHealth();
    assert.equal(health.path, dir);
    assert.equal(health.dataFile, dataFile);
    assert.equal(health.writable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveStoreAtomic round-trips through a writable temp dir", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  configureStorePaths(dir, dataFile);
  try {
    const store = emptyStore();
    store.tasks.push({
      id: "t1",
      title: "T",
      description: "D",
      difficulty: "easy",
      constraints: [],
      status: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await saveStoreAtomic(store);

    const reloaded = loadStore();
    assert.equal(reloaded.tasks.length, 1);
    assert.equal(reloaded.tasks[0].id, "t1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleCreateTask persists the task to disk", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  configureStorePaths(dir, dataFile);
  try {
    const res = await handleCreateTask(emptyStore(), {
      title: "Persist me",
      description: "D",
      difficulty: "medium",
    });
    assert.ok("result" in res, "task should be created in a writable dir");

    const reloaded = loadStore();
    assert.equal(reloaded.tasks.length, 1);
    assert.equal(reloaded.tasks[0].title, "Persist me");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "read-only storage dir is reported unwritable and save fails loudly",
  { skip: isRoot },
  async () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o555);
    const dataFile = path.join(dir, "swarm_board.json");
    configureStorePaths(dir, dataFile);
    try {
      const health = getStorageHealth();
      assert.equal(health.writable, false);

      await assert.rejects(saveStoreAtomic(emptyStore()), /EACCES|EPERM|Error/);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "handleCreateTask returns a JSON-RPC error instead of fake success when storage is read-only",
  { skip: isRoot },
  async () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o555);
    const dataFile = path.join(dir, "swarm_board.json");
    configureStorePaths(dir, dataFile);
    try {
      const res = await handleCreateTask(emptyStore(), {
        title: "Doomed",
        description: "D",
        difficulty: "easy",
      });
      assert.ok("error" in res, "expected an error, not fake success");
      assert.equal(res.error.code, -32603);
      assert.match(res.error.message, /persist/);

      // The failed task must not be silently claimable as created.
      assert.equal(loadStore().tasks.length, 0);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "an unreadable board file is reported as unavailable and never archived or overwritten",
  { skip: isRoot },
  async () => {
    const dir = tmpDir();
    const dataFile = path.join(dir, "swarm_board.json");
    const original = JSON.stringify(seededStore());
    fs.writeFileSync(dataFile, original, "utf-8");
    fs.chmodSync(dataFile, 0o000);
    configureStorePaths(dir, dataFile);
    try {
      assert.throws(loadStore, BoardUnavailableError);

      // No .corrupt archive was created: this is an I/O fault, not corruption.
      assert.deepEqual(
        fs.readdirSync(dir).filter((name) => name.includes(".corrupt-")),
        [],
        "an I/O failure must not archive the live board",
      );

      // A save must refuse rather than replacing the unreadable-but-valid file.
      await assert.rejects(saveStoreAtomic(emptyStore()), BoardUnavailableError);
      await assert.rejects(saveStoreAtomic(seededStore()), BoardUnavailableError);

      fs.chmodSync(dataFile, 0o644);
      assert.equal(fs.readFileSync(dataFile, "utf-8"), original, "original bytes must be untouched");
    } finally {
      fs.chmodSync(dataFile, 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("a directory where the board file belongs returns an unavailable error without data loss", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  // readFileSync(dir) fails with EISDIR on every platform: a non-retryable
  // I/O error that must not be mistaken for corruption.
  fs.mkdirSync(dataFile);
  configureStorePaths(dir, dataFile);
  try {
    assert.throws(loadStore, BoardUnavailableError);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".corrupt-")), []);
    assert.equal(fs.statSync(dataFile).isDirectory(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("EMFILE on read is retried with bounded backoff and then succeeds", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  const original = JSON.stringify(seededStore());
  fs.writeFileSync(dataFile, original, "utf-8");
  configureStorePaths(dir, dataFile);

  let calls = 0;
  const restore = mockReadFileSync((real) => ((...args: Parameters<typeof real>) => {
    calls += 1;
    if (calls <= 2) throw ioError("EMFILE");
    return real(...args);
  }) as typeof real);
  try {
    const store = loadStore();
    assert.equal(store.tasks.length, 1);
    assert.equal(store.tasks[0].id, "t1");
    assert.equal(calls, 3, "expected exactly two retries before the successful read");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exhausted EMFILE retries fail retryably, leave the file intact, and block the next save", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  const original = JSON.stringify(seededStore());
  fs.writeFileSync(dataFile, original, "utf-8");
  configureStorePaths(dir, dataFile);

  let calls = 0;
  const restore = mockReadFileSync(() => (() => {
    calls += 1;
    throw ioError("EMFILE");
  }) as unknown as typeof fs.readFileSync);
  try {
    assert.throws(loadStore, BoardUnavailableError);
    assert.ok(calls >= 2, "expected bounded retries, not a single attempt");

    // Clear the fault, then verify the bytes and the still-blocked save path.
    restore();
    assert.equal(fs.readFileSync(dataFile, "utf-8"), original);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".corrupt-")), []);

    // Still refusing after the fault clears, until a fresh load succeeds.
    await assert.rejects(saveStoreAtomic(emptyStore()), BoardUnavailableError);
    assert.equal(fs.readFileSync(dataFile, "utf-8"), original);

    // A successful load re-arms saving.
    assert.equal(loadStore().tasks.length, 1);
    const next = emptyStore();
    await saveStoreAtomic(next);
    assert.equal(JSON.parse(fs.readFileSync(dataFile, "utf-8")).tasks.length, 0);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid JSON is archived (bytes preserved) and the board recovers empty", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  const corrupt = '{"tasks": [ {"id": "t1" }  BROKEN';
  fs.writeFileSync(dataFile, corrupt, "utf-8");
  configureStorePaths(dir, dataFile);
  try {
    const store = loadStore();
    assert.deepEqual(store, emptyStore());

    const archives = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    assert.equal(archives.length, 1, "expected one corrupt archive");
    assert.equal(
      fs.readFileSync(path.join(dir, archives[0]), "utf-8"),
      corrupt,
      "the archive must contain the exact original bytes",
    );
    // Copy, not rename: the original path still exists until the next save.
    assert.equal(fs.readFileSync(dataFile, "utf-8"), corrupt);

    // Saving after an archived corruption is allowed and produces a valid board.
    const next = seededStore();
    await saveStoreAtomic(next);
    assert.equal(loadStore().tasks.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, archives[0]), "utf-8"), corrupt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a structurally invalid board is archived before returning empty", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  const badShape = JSON.stringify({ tasks: { not: "an array" } });
  fs.writeFileSync(dataFile, badShape, "utf-8");
  configureStorePaths(dir, dataFile);
  try {
    assert.deepEqual(loadStore(), emptyStore());
    const archives = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    assert.equal(archives.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, archives[0]), "utf-8"), badShape);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty board is never written over an existing non-empty file without a successful load", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  fs.writeFileSync(dataFile, JSON.stringify(seededStore()), "utf-8");
  // No loadStore() call: a caller handing us a stale empty view must not erase
  // the persisted board.
  configureStorePaths(dir, dataFile);
  try {
    await assert.rejects(saveStoreAtomic(emptyStore()), BoardUnavailableError);
    assert.equal(loadStore().tasks.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("when a corrupt board cannot be archived, the original is kept and saves stay blocked", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  const corrupt = '{"tasks": [';
  fs.writeFileSync(dataFile, corrupt, "utf-8");
  configureStorePaths(dir, dataFile);

  const realRenameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).includes(".corrupt-")) throw ioError("EACCES");
    return realRenameSync(from, to);
  };
  try {
    assert.throws(loadStore, BoardUnavailableError);
  } finally {
    fs.renameSync = realRenameSync;
  }

  try {
    // Nothing was renamed, replaced, or partially archived.
    assert.equal(fs.readFileSync(dataFile, "utf-8"), corrupt);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".corrupt-")), []);
    // Without a preserved copy, the only bytes left must never be overwritten.
    await assert.rejects(saveStoreAtomic(seededStore()), BoardUnavailableError);
    assert.equal(fs.readFileSync(dataFile, "utf-8"), corrupt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("corruption archives exact bytes once even when workers keep polling", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, "swarm_board.json");
  configureStorePaths(dir, dataFile);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"messages":[{"content":"'), Buffer.from([0xff]), Buffer.from('"}]}')]);
  fs.writeFileSync(dataFile, invalidUtf8);
  for (let i = 0; i < 3; i++) assert.deepEqual(loadStore(), emptyStore());
  const archives = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(archives.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, archives[0])), invalidUtf8);
  assert.deepEqual(fs.readFileSync(dataFile), invalidUtf8);
});

test("concurrent artifact syncs and a task write retain both artifacts", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  const sync = (agentId: string) => withLockedStore((store) => handleSyncArtifact(store, {
    runId: "run_fixture", agentId, taskId: "t1", computeTarget: "cloud", files: ["README.md"], summary: "Updated docs",
  }));
  const results = await Promise.all([
    sync("lane-1"),
    withLockedStore((store) => handleCreateTask(store, { title: "Docs", description: "Edit docs", difficulty: "easy" })),
    sync("lane-2"),
  ]);
  assert.ok(results.every((result) => "result" in result));
  const saved = loadStore();
  assert.equal(saved.tasks.length, 1);
  assert.deepEqual(saved.artifacts?.map(({ agentId }) => agentId), ["lane-1", "lane-2"]);
});

test("ENOSPC cannot publish a claim, replace the prior snapshot, or leave a temp file", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, "swarm_board.json");
  configureStorePaths(dir, dataFile);
  await saveStoreAtomic(seededStore());
  const before = fs.readFileSync(dataFile, "utf-8");
  const realRename = fs.promises.rename;
  const rename = t.mock.method(fs.promises, "rename", async (from: fs.PathLike, to: fs.PathLike) => {
    if (to === dataFile) throw ioError("ENOSPC");
    return realRename(from, to);
  });
  const args = { taskId: "t1", agentName: "worker" };
  const result = await withLockedStore(async (store) => {
    const failed = await handleClaimTask(store, args);
    assert.equal(store.tasks[0].status, "open");
    assert.equal(store.tasks[0].history, undefined);
    return failed;
  });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32603);
  assert.match(result.error.message, /ENOSPC/);
  assert.equal(fs.readFileSync(dataFile, "utf-8"), before);
  assert.deepEqual(fs.readdirSync(dir), ["swarm_board.json"]);
  rename.mock.restore();
  assert.ok("result" in await withLockedStore((store) => handleClaimTask(store, args)));
  assert.equal(loadStore().tasks[0].claimedBy, "worker");
});
