import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpSessionEpoch,
  configureUserPaths,
  emailForUserId,
  getSessionEpoch,
  normalizeEmail,
  signupLocalUser,
  localUserExists,
  verifyLocalUser,
  hashPassword,
  parseScryptHash,
  DEFAULT_SCRYPT_COST,
} from "./users.js";

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-users-test-"));
  configureUserPaths(path.join(dir, "users.json"));
});

test.afterEach(() => {
  configureUserPaths("");
  delete process.env.SWARM_SCRYPT_MAX_CONCURRENCY;
  delete process.env.SWARM_SCRYPT_MAX_QUEUE;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("signupLocalUser persists and verifyLocalUser authenticates", async () => {
  const created = await signupLocalUser(" Alice@Example.COM ", "correct horse battery");
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.user.email, "alice@example.com");
  assert.equal(created.user.uid, "local_alice@example.com");

  // Case-insensitive, whitespace-tolerant login.
  assert.deepEqual(await verifyLocalUser("ALICE@example.com", "correct horse battery"), created.user);
  assert.equal(await verifyLocalUser("alice@example.com", "wrong password"), null);
  assert.equal(await verifyLocalUser("nobody@example.com", "correct horse battery"), null);

  // The file is written to disk, so a fresh read finds the user.
  const again = await verifyLocalUser("alice@example.com", "correct horse battery");
  assert.ok(again);
});

test("passwords are stored as salted scrypt hashes, never plaintext", async () => {
  await signupLocalUser("alice@example.com", "hunter2secret");
  const raw = fs.readFileSync(path.join(dir, "users.json"), "utf-8");
  assert.ok(!raw.includes("hunter2secret"), "password must not appear in the store");
  assert.match(raw, /scrypt\$/);
});

test("signupLocalUser rejects invalid email, weak password, duplicates", async () => {
  assert.deepEqual(await signupLocalUser("not-an-email", "longenough123"), { ok: false, error: "invalid" });
  assert.deepEqual(await signupLocalUser("a@b.co", "short"), { ok: false, error: "invalid" });
  assert.deepEqual(await signupLocalUser(null, "longenough123"), { ok: false, error: "invalid" });
  assert.equal((await signupLocalUser("dup@example.com", "validpassword123")).ok, true);
  assert.deepEqual(await signupLocalUser("dup@example.com", "anotherpassword123"), { ok: false, error: "exists" });
  assert.deepEqual(await signupLocalUser("DUP@example.com", "anotherpassword123"), { ok: false, error: "exists" });
});

test("emailForUserId shows the real address for local accounts", () => {
  assert.equal(emailForUserId("local_alice@example.com"), "alice@example.com");
  assert.equal(emailForUserId("local_ALICE@Example.COM"), "ALICE@Example.COM");
  // Non-local identities keep the internal display domain.
  assert.equal(emailForUserId("alice"), "alice@swarmagents.local");
  assert.equal(emailForUserId("harness"), "harness@swarmagents.local");
  // A local-looking id without an address is not stripped into an empty email.
  assert.equal(emailForUserId("local_alice"), "local_alice@swarmagents.local");
});

test("normalizeEmail canonicalizes and rejects garbage", () => {
  assert.equal(normalizeEmail("  Bob@Example.COM  "), "bob@example.com");
  assert.equal(normalizeEmail("a b@c.com"), "");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(42), "");
  assert.equal(normalizeEmail("a".repeat(300) + "@x.com"), "");
});

test("getSessionEpoch/bumpSessionEpoch revoke sessions for one user only", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");
  await signupLocalUser("bob@example.com", "another strong secret");

  // Fresh accounts have never revoked: epoch 0.
  assert.equal(getSessionEpoch("alice@example.com"), 0);
  assert.equal(getSessionEpoch("bob@example.com"), 0);
  assert.equal(getSessionEpoch("nobody@example.com"), 0);
  assert.equal(getSessionEpoch("not-an-email"), 0);

  // Bump alice's epoch; bob and unknown accounts are untouched.
  assert.equal(await bumpSessionEpoch("alice@example.com"), true);
  const epoch = getSessionEpoch("alice@example.com");
  // The epoch is Unix milliseconds: within a few seconds of now, and far
  // too large to be seconds (a seconds value would be ~1.7e9).
  assert.ok(epoch > Date.now() - 5_000 && epoch <= Date.now(), `epoch should be a recent unix-millisecond time, got ${epoch}`);
  assert.equal(getSessionEpoch("bob@example.com"), 0);

  // An unknown account cannot be bumped.
  assert.equal(await bumpSessionEpoch("nobody@example.com"), false);
  assert.equal(await bumpSessionEpoch("not-an-email"), false);
});

test("concurrent signups for different users both persist; same-email second signup reports exists", async () => {
  // Two signups racing through the scrypt hash must not lose one: the
  // second writer re-reads inside the lock before saving.
  const results = await Promise.all([
    signupLocalUser("race-one@example.com", "long enough password"),
    signupLocalUser("race-two@example.com", "long enough password"),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 2, "both racing signups must persist");
  assert.equal(localUserExists("race-one@example.com"), true);
  assert.equal(localUserExists("race-two@example.com"), true);

  // The same race for one email: exactly one account is created and the
  // loser reports "exists" instead of silently overwriting the first.
  const dupes = await Promise.all([
    signupLocalUser("race-dup@example.com", "long enough password"),
    signupLocalUser("race-dup@example.com", "another long password"),
  ]);
  assert.equal(dupes.filter((r) => r.ok).length, 1, "exactly one same-email signup must win");
  assert.deepEqual(
    dupes.filter((r) => !r.ok).map((r) => (r as { error: string }).error),
    ["exists"],
    "the loser must report exists",
  );
  assert.equal(localUserExists("race-dup@example.com"), true);
});

test("verifyLocalUser timing is uniform between unknown email and wrong password", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");
  const wrongPassword = "definitely-wrong-password";

  const knownWrong = () => verifyLocalUser("alice@example.com", wrongPassword);
  const unknown = () => verifyLocalUser("nobody@example.com", wrongPassword);

  // Warm up the scrypt pool / caches so the first call does not skew ratios.
  for (let i = 0; i < 3; i++) {
    await knownWrong();
    await unknown();
  }

  const N = 10;
  let knownTotal = 0;
  let unknownTotal = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await knownWrong();
    knownTotal += performance.now() - t0;

    const t1 = performance.now();
    await unknown();
    unknownTotal += performance.now() - t1;
  }
  const knownAvg = knownTotal / N;
  const unknownAvg = unknownTotal / N;
  assert.ok(unknownAvg > 0, `unknown-email verification should cost something, got ${unknownAvg}ms`);
  // An unknown email must not be meaningfully faster than a known wrong
  // password, otherwise accounts could be enumerated by response timing.
  // Allow generous slack for scheduling noise (DoD: ratio < 3x).
  assert.ok(knownAvg < unknownAvg * 3, `known=${knownAvg.toFixed(2)}ms unknown=${unknownAvg.toFixed(2)}ms`);
});

test("password verification yields to the event loop (async, non-blocking)", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");

  const order: string[] = [];
  const timerPromise = new Promise<void>((resolve) => {
    // Fire ~5ms after the timer is set. scrypt takes ~25ms, so if
    // verification is async the timer wins; if it blocked synchronously the
    // verification would resolve first.
    setTimeout(() => {
      order.push("timer");
      resolve();
    }, 5);
  });

  const verifyPromise = verifyLocalUser("alice@example.com", "wrong-password").then(() => {
    order.push("verify");
  });
  await Promise.all([timerPromise, verifyPromise]);

  assert.deepEqual(order, ["timer", "verify"], "a short timer must fire while verification is still pending");
});

test("the parsed user store is cached across lookups and re-read after a write", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");

  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: unknown[]) => {
    reads++;
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as typeof fs.readFileSync;

  try {
    // N logins: the first re-stats and reads, the rest hit the cache.
    for (let i = 0; i < 8; i++) {
      assert.ok(await verifyLocalUser("alice@example.com", "correct horse battery"));
    }
    assert.equal(reads, 1, `expected one file read across 8 logins, got ${reads}`);

    // A write invalidates the cache in-process...
    assert.equal((await signupLocalUser("bob@example.com", "another strong secret")).ok, true);
    assert.equal(reads, 1, "signup's own load used the cache; only the write invalidates");

    // ...so the next lookup re-reads and sees the new account.
    assert.ok(await verifyLocalUser("bob@example.com", "another strong secret"));
    assert.equal(reads, 2, `expected a re-read after the write, got ${reads}`);
  } finally {
    fs.readFileSync = original;
  }
});

test("the cache notices external edits by mtime/size", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");
  assert.equal(localUserExists("alice@example.com"), true);
  assert.equal(localUserExists("bob@example.com"), false);

  // Simulate another process appending a user behind this process's back.
  const file = path.join(dir, "users.json");
  const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    version: 1;
    users: Array<{ email: string; password: string; createdAt: number }>;
  };
  data.users.push({ email: "bob@example.com", password: "scrypt$00$00", createdAt: Date.now() });
  fs.writeFileSync(file, JSON.stringify(data));
  // Force a distinct mtime even on filesystems with coarse timestamps.
  const later = new Date(Date.now() + 2_000);
  fs.utimesSync(file, later, later);

  assert.equal(localUserExists("bob@example.com"), true, "cache must pick up an external write");
});

test("scrypt derivations are capped: waiters queue, then shed load past the queue", async () => {
  process.env.SWARM_SCRYPT_MAX_CONCURRENCY = "1";
  process.env.SWARM_SCRYPT_MAX_QUEUE = "1";

  // Three concurrent signups: one runs, one waits, the third is shed.
  const results = await Promise.all([
    signupLocalUser("one@example.com", "long enough password"),
    signupLocalUser("two@example.com", "long enough password"),
    signupLocalUser("three@example.com", "long enough password"),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 2, "the queued derivation must still run");
  assert.deepEqual(
    results.filter((r) => !r.ok).map((r) => (r as { error: string }).error),
    ["busy"],
    "only the derivation past the queue is rejected",
  );
});

test("queueing is FIFO and the cap recovers after load drops", async () => {
  process.env.SWARM_SCRYPT_MAX_CONCURRENCY = "1";
  process.env.SWARM_SCRYPT_MAX_QUEUE = "0";

  const first = signupLocalUser("first@example.com", "long enough password");
  const shed = await signupLocalUser("shed@example.com", "long enough password");
  assert.deepEqual(shed, { ok: false, error: "busy" }, "no queue means immediate shedding");
  assert.equal((await first).ok, true);

  // Once the slot frees, new work is admitted again.
  assert.equal((await signupLocalUser("after@example.com", "long enough password")).ok, true);
});

test("no synchronous scrypt call remains in the source tree", () => {
  // Build the needle at runtime so this guard does not match itself.
  const needle = ["scrypt", "Sync"].join("");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const roots = ["app", "lib", "components", "scripts", "minimalist-ui"];
  const files = [
    "instrumentation.ts",
    "middleware.ts",
    "next.config.ts",
    ...roots.flatMap((r) => collectSourceFiles(path.join(root, r))),
  ];

  const hits: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (text.includes(needle)) hits.push(path.relative(root, file));
  }
  assert.deepEqual(hits, [], `${needle} must not be used: ${hits.join(", ")}`);
});

test("supports versioned scrypt hashes with custom cost parameters", async () => {
  const customCost = { N: 8192, r: 8, p: 1, maxmem: 16 * 1024 * 1024 };
  const hashed = await hashPassword("custompassword", customCost);
  assert.match(hashed, /^scrypt\$N=8192,r=8,p=1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

  const parsed = parseScryptHash(hashed);
  assert.ok(parsed);
  assert.equal(parsed.versioned, true);
  assert.equal(parsed.cost.N, 8192);
  assert.equal(parsed.cost.r, 8);
  assert.equal(parsed.cost.p, 1);
});

test("authenticates legacy 3-part scrypt hash and transparently upgrades to versioned", async () => {
  // Manually seed a user with a legacy 3-part hash: scrypt$<salt>$<hash>
  const legacyHash = "scrypt$33247306aac749054795c00127be0ecf$945ffa6bb3d59a4b3d46e77f8a6f5c1cb0bc5d549c017b4b5d9e90dd74a00ba9";
  const userFile = path.join(dir, "users.json");
  fs.writeFileSync(
    userFile,
    JSON.stringify({
      version: 1,
      users: [{ email: "legacy@example.com", password: legacyHash, createdAt: Date.now() }],
    }),
    "utf-8",
  );

  // Authenticates with wrong password -> fails
  assert.equal(await verifyLocalUser("legacy@example.com", "wrongpassword"), null);

  // We need a legacy hash with a known password:
  const pwd = "mypassword123";
  const newLegacy = (await hashPassword(pwd)).replace(/^scrypt\$N=\d+,r=\d+,p=\d+\$/, "scrypt$");
  assert.equal(newLegacy.split("$").length, 3);

  fs.writeFileSync(
    userFile,
    JSON.stringify({
      version: 1,
      users: [{ email: "upgrade@example.com", password: newLegacy, createdAt: Date.now() }],
    }),
    "utf-8",
  );

  const auth = await verifyLocalUser("upgrade@example.com", pwd);
  assert.ok(auth);
  assert.equal(auth.email, "upgrade@example.com");

  // Wait briefly for transparent background upgrade to finish
  await new Promise((r) => setTimeout(r, 100));

  const updatedUsers = JSON.parse(fs.readFileSync(userFile, "utf-8")) as { users: Array<{ password: string }> };
  const updatedUser = updatedUsers.users.find((u) => u.password !== legacyHash);
  assert.ok(updatedUser);
  assert.match(updatedUser.password, /^scrypt\$N=16384,r=8,p=1\$/);

  // Still authenticates cleanly with upgraded hash
  const authAgain = await verifyLocalUser("upgrade@example.com", pwd);
  assert.ok(authAgain);
});

test("session revocation followed by immediate re-login works with counter epoch", async () => {
  await signupLocalUser("revoker@example.com", "password123");
  const epochBefore = getSessionEpoch("revoker@example.com");
  assert.equal(epochBefore, 0);

  const bumped = await bumpSessionEpoch("revoker@example.com");
  assert.equal(bumped, true);
  const epochAfter = getSessionEpoch("revoker@example.com");
  assert.ok(epochAfter > epochBefore);

  // Immediate re-login succeeds
  const login = await verifyLocalUser("revoker@example.com", "password123");
  assert.ok(login);
  assert.equal(login.email, "revoker@example.com");
});

/** Every .ts/.tsx/.js/.mjs/.cjs file below `dir`, skipping build and vendor dirs. */
function collectSourceFiles(dir: string): string[] {
  const skip = new Set(["node_modules", ".next", ".git", "coverage", "dist"]);
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) out.push(...collectSourceFiles(full));
    } else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
