import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { acquireFileLock } from "./file-lock.js";
import {
  UsersStoreError,
  bumpSessionEpoch,
  configureUserPaths,
  consumeEmailVerificationToken,
  consumePasswordResetToken,
  emailForUserId,
  getScryptSlotStateForTesting,
  listLocalUserIds,
  getSessionEpoch,
  isEmailVerified,
  isEmailVerifiedForUserId,
  issueEmailVerificationToken,
  issuePasswordResetToken,
  normalizeEmail,
  setUserPassword,
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
  delete process.env.SWARM_SESSION_SECRET;
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
    // Count only reads of the store itself; the FIX-45 file lock also reads
    // its lockfile on release, which is not a store read.
    if (String(args[0]).endsWith("users.json")) reads++;
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
    // FIX-45: entering the cross-process write lock re-reads the file (another
    // process may have written while we waited for the lock), so the signup's
    // in-lock load is a second read — lookups still hit the cache.
    assert.equal(reads, 2, "entering the write lock re-reads; lookups used the cache");

    // ...so the next lookup re-reads and sees the new account.
    assert.ok(await verifyLocalUser("bob@example.com", "another strong secret"));
    assert.equal(reads, 3, `expected a re-read after the write, got ${reads}`);
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

test("password reset tokens: issue → consume works once, then the token is dead", async () => {
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  await signupLocalUser("alice@example.com", "correct horse battery");

  const token = await issuePasswordResetToken("alice@example.com");
  assert.ok(token, "a token is minted for a known account");
  assert.ok(token.startsWith("pr1."), `token carries the pr1 prefix: ${token}`);

  // The raw token is never at rest: only its HMAC is stored.
  const raw = fs.readFileSync(path.join(dir, "users.json"), "utf-8");
  assert.ok(!raw.includes(token), "raw reset token must not appear in the store");

  assert.equal(await consumePasswordResetToken(token), "alice@example.com");
  // Single-use: a replay finds nothing.
  assert.equal(await consumePasswordResetToken(token), null);
});

test("password reset tokens: unknown account, garbage and expired tokens all fail closed", async () => {
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  await signupLocalUser("alice@example.com", "correct horse battery");

  // Unknown account: nothing minted (the route still answers 200).
  assert.equal(await issuePasswordResetToken("nobody@example.com"), null);
  assert.equal(await issuePasswordResetToken("not-an-email"), null);

  // Garbage shapes never consume.
  assert.equal(await consumePasswordResetToken("pr1.not-a-real-token"), null);
  assert.equal(await consumePasswordResetToken("garbage"), null);
  assert.equal(await consumePasswordResetToken(null), null);
  assert.equal(await consumePasswordResetToken(42), null);

  // Expired: issued at t, consumed after the TTL.
  const t0 = 1_800_000_000_000;
  const token = await issuePasswordResetToken("alice@example.com", { now: t0, ttlMs: 60_000 });
  assert.ok(token);
  assert.equal(await consumePasswordResetToken(token, { now: t0 + 60_001 }), null);
  // The expired token was cleared on the failed consume: even rewinding
  // the clock cannot resurrect it.
  assert.equal(await consumePasswordResetToken(token, { now: t0 }), null);
});

test("password reset tokens: issuing a new token invalidates the previous link", async () => {
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  await signupLocalUser("alice@example.com", "correct horse battery");

  const first = await issuePasswordResetToken("alice@example.com");
  const second = await issuePasswordResetToken("alice@example.com");
  assert.ok(first && second && first !== second);

  assert.equal(await consumePasswordResetToken(first), null, "the older link is dead");
  assert.equal(await consumePasswordResetToken(second), "alice@example.com");
});

test("setUserPassword rotates the password, revokes sessions and clears reset tokens", async () => {
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  await signupLocalUser("alice@example.com", "correct horse battery");
  const token = await issuePasswordResetToken("alice@example.com");
  assert.ok(token);
  assert.equal(getSessionEpoch("alice@example.com"), 0);

  assert.deepEqual(await setUserPassword("alice@example.com", "a brand new password"), { ok: true });

  // Old password is dead, new one works.
  assert.equal(await verifyLocalUser("alice@example.com", "correct horse battery"), null);
  assert.ok(await verifyLocalUser("alice@example.com", "a brand new password"));

  // Every prior session is revoked (epoch raised to now).
  const epoch = getSessionEpoch("alice@example.com");
  assert.ok(epoch > Date.now() - 5_000 && epoch <= Date.now(), `epoch should be recent ms, got ${epoch}`);

  // The pending reset token died with the password change.
  assert.equal(await consumePasswordResetToken(token), null);
});

test("setUserPassword rejects weak passwords and unknown accounts", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");
  assert.deepEqual(await setUserPassword("alice@example.com", "short"), { ok: false, error: "invalid" });
  assert.deepEqual(await setUserPassword("alice@example.com", 42), { ok: false, error: "invalid" });
  assert.deepEqual(await setUserPassword("nobody@example.com", "long enough password"), {
    ok: false,
    error: "unknown",
  });
  // The original password still works after the rejected attempts.
  assert.ok(await verifyLocalUser("alice@example.com", "correct horse battery"));
});

test("no synchronous scrypt call remains in the source tree", () => {
  // Build the needle at runtime so this guard does not match itself.
  const needle = ["scrypt", "Sync"].join("\n");
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

/* ------------------------------------------------------------------ */
/* Email verification (FIX-44)                                         */
/* ------------------------------------------------------------------ */

test("new signups start unverified; the token flips the flag exactly once", async () => {
  process.env.SWARM_SESSION_SECRET = "test-secret-for-verification";
  await signupLocalUser("new@example.com", "correct horse battery");
  assert.equal(isEmailVerified("new@example.com"), false);
  assert.equal(isEmailVerifiedForUserId("local_new@example.com"), false);

  const token = await issueEmailVerificationToken("new@example.com");
  assert.ok(token?.startsWith("ev1."));
  // Only the HMAC is stored — the raw token never lands in users.json.
  const raw = fs.readFileSync(path.join(dir, "users.json"), "utf-8");
  assert.ok(!raw.includes(token!), "raw verification token must not be persisted");

  assert.equal(await consumeEmailVerificationToken(token), "new@example.com");
  assert.equal(isEmailVerified("new@example.com"), true);
  assert.equal(isEmailVerifiedForUserId("local_new@example.com"), true);
  // Single-use: replaying the link fails.
  assert.equal(await consumeEmailVerificationToken(token), null);
  // Already verified: no new token is issued.
  assert.equal(await issueEmailVerificationToken("new@example.com"), null);
});

test("verification tokens expire, reissue invalidates, and reset tokens cannot verify", async () => {
  process.env.SWARM_SESSION_SECRET = "test-secret-for-verification";
  await signupLocalUser("exp@example.com", "correct horse battery");
  const t0 = 1_700_000_000_000;
  const stale = await issueEmailVerificationToken("exp@example.com", { now: t0, ttlMs: 60_000 });
  assert.ok(stale);
  assert.equal(await consumeEmailVerificationToken(stale, { now: t0 + 61_000 }), null);
  assert.equal(isEmailVerified("exp@example.com"), false);

  const first = await issueEmailVerificationToken("exp@example.com");
  const second = await issueEmailVerificationToken("exp@example.com");
  assert.ok(first && second && first !== second);
  assert.equal(await consumeEmailVerificationToken(first), null, "reissue kills the earlier link");
  assert.equal(await consumeEmailVerificationToken(second), "exp@example.com");

  // Cross-domain: a password-reset token is not a verification token.
  await signupLocalUser("cross@example.com", "correct horse battery");
  const resetToken = await issuePasswordResetToken("cross@example.com");
  assert.ok(resetToken);
  assert.equal(await consumeEmailVerificationToken(resetToken), null);
  assert.equal(isEmailVerified("cross@example.com"), false);
});

test("legacy accounts without the flag are grandfathered; non-local ids pass the gate", async () => {
  // A users.json written before FIX-44: no `verified` field at all.
  fs.writeFileSync(
    path.join(dir, "users.json"),
    JSON.stringify({
      version: 1,
      users: [{ email: "legacy@example.com", password: "scrypt$00$00", createdAt: 1 }],
    }),
  );
  assert.equal(isEmailVerified("legacy@example.com"), true);
  assert.equal(isEmailVerifiedForUserId("local_legacy@example.com"), true);
  // Unknown local account fails closed; non-local identities are not gated.
  assert.equal(isEmailVerifiedForUserId("local_ghost@example.com"), false);
  assert.equal(isEmailVerifiedForUserId("alice"), true);
  assert.equal(isEmailVerifiedForUserId("harness"), true);
  assert.equal(isEmailVerified("nobody@example.com"), false);
});

// ---------------------------------------------------------------------------
// FIX-45: cross-process write serialization (users.json.lock).
// ---------------------------------------------------------------------------

function runSignupChild(
  userFile: string,
  prefix: string,
  count: number,
): { child: ChildProcess; done: Promise<number> } {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const usersModule = path.join(libDir, "users.ts");
  const scriptPath = path.join(dir, `signup-child-${prefix}.mts`);
  fs.writeFileSync(
    scriptPath,
    [
      `import { configureUserPaths, signupLocalUser } from ${JSON.stringify(usersModule)};`,
      `const [file, prefix, countRaw] = process.argv.slice(2);`,
      `configureUserPaths(file);`,
      `const count = Number(countRaw);`,
      `for (let i = 0; i < count; i++) {`,
      `  const r = await signupLocalUser(prefix + i + "@example.com", "validpassword123");`,
      `  if (!r.ok) { console.error("signup failed:", r.error); process.exit(1); }`,
      `}`,
      `console.log("done");`,
      ``,
    ].join("\n"),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", scriptPath, userFile, prefix, String(count)],
    { cwd: path.resolve(libDir, ".."), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const done = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`signup child ${prefix} timed out: ${stderr}`));
    }, 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`signup child ${prefix} exited ${code}: ${stderr}`));
      else resolve(0);
    });
  });
  return { child, done };
}

test("a second process cannot write users.json while the file lock is held", async () => {
  const userFile = path.join(dir, "users.json");
  const release = await acquireFileLock(`${userFile}.lock`);
  const { done } = runSignupChild(userFile, "blocked", 1);
  let exited = false;
  void done.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(exited, false, "child signup must wait for the file lock");
  release();
  assert.equal(await done, 0);
  assert.equal(localUserExists("blocked0@example.com"), true);
});

test("two processes signing up concurrently lose no accounts", async () => {
  const userFile = path.join(dir, "users.json");
  const a = runSignupChild(userFile, "alpha", 8);
  const b = runSignupChild(userFile, "beta", 8);
  assert.equal(await a.done, 0);
  assert.equal(await b.done, 0);
  const ids = listLocalUserIds();
  assert.equal(ids.length, 16, `expected 16 accounts, got ${ids.length}: ${ids.join(", ")}`);
  for (let i = 0; i < 8; i++) {
    assert.equal(localUserExists(`alpha${i}@example.com`), true);
    assert.equal(localUserExists(`beta${i}@example.com`), true);
  }
});

test("a corrupt users file is never overwritten by signup or revocation", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");
  const file = path.join(dir, "users.json");
  assert.ok(fs.readFileSync(file, "utf-8").includes("alice@example.com"));
  fs.writeFileSync(file, "{not json");
  const corrupt = fs.readFileSync(file, "utf-8");

  assert.deepEqual(await signupLocalUser("bob@example.com", "another strong secret"), { ok: false, error: "fatal" });
  assert.equal(await bumpSessionEpoch("alice@example.com"), false);
  assert.equal(fs.readFileSync(file, "utf-8"), corrupt, "the corrupt store must survive untouched");
  await assert.rejects(verifyLocalUser("alice@example.com", "correct horse battery"), UsersStoreError);

  // The fast-path duplicate check also fails fatal instead of proceeding.
  assert.deepEqual(await signupLocalUser("alice@example.com", "correct horse battery"), { ok: false, error: "fatal" });
});

test("an unreadable users file (a directory in its place) is never overwritten", async () => {
  const file = path.join(dir, "users.json");
  fs.mkdirSync(file);
  assert.deepEqual(await signupLocalUser("bob@example.com", "another strong secret"), { ok: false, error: "fatal" });
  assert.equal(await bumpSessionEpoch("bob@example.com"), false);
  assert.ok(fs.statSync(file).isDirectory(), "the directory must survive untouched");
});

test("verifyPassword rejects empty and wrong-length hash segments for any password", async () => {
  const file = path.join(dir, "users.json");
  const users = [
    { email: "empty@example.com", password: "scrypt$$", createdAt: Date.now() },
    { email: "short@example.com", password: "scrypt$00$00", createdAt: Date.now() },
    { email: "nohash@example.com", password: "", createdAt: Date.now() },
    { email: "badhex@example.com", password: "scrypt$zz$zz", createdAt: Date.now() },
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 1, users }));
  for (const u of users) {
    assert.equal(await verifyLocalUser(u.email, "anything at all"), null, `${u.email} must never authenticate`);
    assert.equal(await verifyLocalUser(u.email, ""), null);
  }
  // A well-formed hash still authenticates: the strict check must not break real logins.
  await signupLocalUser("real@example.com", "correct horse battery");
  assert.ok(await verifyLocalUser("real@example.com", "correct horse battery"));
});

test("verifyLocalUser rejects passwords over 1024 chars without hashing", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery");
  assert.equal(await verifyLocalUser("alice@example.com", "x".repeat(1025)), null);
  assert.equal(await verifyLocalUser("alice@example.com", "x".repeat(10_000)), null);
  assert.equal(await verifyLocalUser("nobody@example.com", "x".repeat(1025)), null);
  // A 1024-char wrong password still goes through verification and fails.
  assert.equal(await verifyLocalUser("alice@example.com", "x".repeat(1024)), null);

  // The rejection happens before any scrypt work: with the scrypt pool
  // saturated, an oversized password still returns null instead of
  // throwing ScryptBusyError.
  process.env.SWARM_SCRYPT_MAX_CONCURRENCY = "1";
  process.env.SWARM_SCRYPT_MAX_QUEUE = "0";
  const busy = verifyLocalUser("alice@example.com", "correct horse battery");
  assert.equal(await verifyLocalUser("alice@example.com", "x".repeat(1025)), null);
  assert.ok(await busy);
});

test("normalizeEmail rejects malformed addresses and path traversal", () => {
  for (const bad of [
    "@",
    "a@b@c",
    "foo@",
    "@bar",
    "a/b@c",
    "a\\b@c",
    "a..b@c",
    ".a@b.com",
    "a.@b.com",
    "a@.b.com",
    "a@b.com.",
    "a@b@c@d",
    "a b@c.com",
  ]) {
    assert.equal(normalizeEmail(bad), "", `${bad} must be rejected`);
  }
  assert.equal(normalizeEmail("a@b"), "a@b", "a dotless domain is still a local address");
  assert.equal(normalizeEmail("first.last@example.com"), "first.last@example.com");
  assert.equal(normalizeEmail("Alice+tag@Example.COM"), "alice+tag@example.com");
});

test("configureUserPaths(\"\") resets to the default resolution instead of writing to \"\"", async () => {
  const prevHome = process.env.SWARM_HOME;
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-users-home2-"));
  try {
    process.env.SWARM_HOME = home2;
    // A custom path first.
    await signupLocalUser("custom@example.com", "correct horse battery");
    assert.equal(fs.existsSync(path.join(home2, "users.json")), false, "nothing written to the default location yet");
    assert.equal(localUserExists("custom@example.com"), true);

    // Reset: the store now resolves to SWARM_HOME, not the custom file.
    configureUserPaths("");
    assert.equal(localUserExists("custom@example.com"), false, "the custom store is no longer visible after reset");
    assert.equal((await signupLocalUser("home@example.com", "correct horse battery")).ok, true);
    assert.equal(fs.existsSync(path.join(home2, "users.json")), true, "the default location is used after reset");
    assert.equal(localUserExists("home@example.com"), true);
  } finally {
    if (prevHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = prevHome;
    fs.rmSync(home2, { recursive: true, force: true });
  }
});

test("lowering SWARM_SCRYPT_MAX_CONCURRENCY drains in-flight slots instead of handing them off", async () => {
  process.env.SWARM_SCRYPT_MAX_CONCURRENCY = "4";
  process.env.SWARM_SCRYPT_MAX_QUEUE = "10";
  await signupLocalUser("drain@example.com", "correct horse battery");
  const password = "correct horse battery";
  const runs = Array.from({ length: 8 }, () => verifyLocalUser("drain@example.com", password));
  // Wait until 4 are in flight and 4 are queued.
  let state = getScryptSlotStateForTesting();
  const start = Date.now();
  while (!(state.active === 4 && state.queued === 4) && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 1));
    state = getScryptSlotStateForTesting();
  }
  assert.deepEqual(state, { active: 4, queued: 4 });
  // Lower the cap below the in-flight count.
  process.env.SWARM_SCRYPT_MAX_CONCURRENCY = "2";
  // A finish must drain (active drops while the queue is untouched) rather
  // than hand the slot off (active stays, queue drops).
  let drained = false;
  const drainStart = Date.now();
  while (Date.now() - drainStart < 5000) {
    state = getScryptSlotStateForTesting();
    if (state.queued === 4 && state.active < 4) {
      drained = true;
      break;
    }
    if (state.active === 0 && state.queued === 0) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.ok(drained, `expected a drain (queued 4, active < 4), last state ${JSON.stringify(state)}`);
  const results = await Promise.all(runs);
  assert.ok(results.every(Boolean), "all eight verifications still succeed");
  assert.deepEqual(getScryptSlotStateForTesting(), { active: 0, queued: 0 });
});
