// Admin bootstrap, per-user storage quota and the admin-only Analytics API, in server mode.
// - bootstrapAdmin() creates the admin once from SWARM_ADMIN_EMAIL + SWARM_ADMIN_PASSWORD_FILE, is idempotent,
//   never promotes an existing account, and drops the password from process.env.
// - The admin signs in with the email; a normal sign-up can never become admin.
// - /api/admin/analytics and /api/admin/users answer 403 to everyone but the admin.
// - Quota: 0.5 GB default, 5 GB for the admin, per-user override set by the admin.
// Run: npx tsx tests/tenant-admin.mjs   (part of npm run test:tenant)
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tenant-admin-"));
const pwFile = path.join(home, "admin-password");
const ADMIN_PW = crypto.randomBytes(18).toString("base64url"); // random per run, never printed
fs.writeFileSync(pwFile, ADMIN_PW + "\n", { mode: 0o600 });
Object.assign(process.env, { SWARM_HOME: home, SWARM_MODE: "server", SWARM_SIGNUP: "open", SWARM_SIGNUP_CAPTCHA: "off" /* captcha has its own test: tests/signup-captcha.mjs */, SWARM_ADMIN_EMAIL: "Admin.Test@Example.com", SWARM_ADMIN_PASSWORD_FILE: pwFile, SWARM_ADMIN_PASSWORD: "env-copy-must-vanish-123" });
delete process.env.SWARM_STORAGE_QUOTA_MB;

const users = await import("../lib/users.ts");
const admin = await import("../lib/tenant/admin.ts");
const st = await import("../lib/tenant/storage.ts");
const signup = await import("../app/api/signup/route.ts");
const analytics = await import("../app/api/admin/analytics/route.ts");
const adminUsers = await import("../app/api/admin/users/route.ts");

let pass = 0;
const t = async (name, fn) => {
  await fn();
  pass++;
  console.log("  ok", name);
};
const req = (url, { token, method = "GET", body } = {}) =>
  new Request(`http://127.0.0.1${url}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const logs = [];
const log = (s) => logs.push(s);

try {
  let adminUser;
  await t("bootstrap creates the admin from the email + password file, and logs no password", () => {
    const r = admin.bootstrapAdmin(log);
    assert.equal(r.status, "created");
    adminUser = users.findUserByEmail("admin.test@example.com");
    assert.ok(adminUser?.isAdmin, "is admin");
    assert.ok(!logs.join("\n").includes(ADMIN_PW), "password never logged");
    assert.equal(process.env.SWARM_ADMIN_PASSWORD, undefined, "env copy removed after reading");
    const db = fs.readFileSync(path.join(home, "auth.db"));
    assert.ok(!db.includes(Buffer.from(ADMIN_PW)), "stored hashed, not in plain text");
  });

  await t("bootstrap is idempotent: a second (and third) start changes nothing", () => {
    const before = users.userCount();
    assert.equal(admin.bootstrapAdmin(log).status, "exists");
    assert.equal(admin.bootstrapAdmin(log).status, "exists");
    assert.equal(users.userCount(), before);
  });

  await t("the admin signs in with the email (any case); a wrong password fails", () => {
    assert.equal(users.authenticate("ADMIN.test@example.com", ADMIN_PW)?.id, adminUser.id);
    assert.equal(users.authenticate("admin.test@example.com", "wrong-password-123"), null);
  });

  let bobToken, aliceToken, adminToken, bob;
  await t("a normal sign-up never gets admin, even with the admin's email or username", async () => {
    let r = await signup.POST(req("/api/signup", { method: "POST", body: { username: "admin.test@example.com", password: "Bob-password-1234" } }));
    assert.equal(r.status, 400, "an email can't be a username");
    r = await signup.POST(req("/api/signup", { method: "POST", body: { username: "bob", password: "Bob-password-1234", email: "admin.test@example.com" } }));
    assert.equal(r.status, 200);
    bob = users.authenticate("bob", "Bob-password-1234");
    assert.ok(bob && !bob.isAdmin, "bob is not admin");
    assert.equal(users.userById(bob.id).email, null, "sign-up can't set an email");
    r = await signup.POST(req("/api/signup", { method: "POST", body: { username: "admin.test-2", password: "Alice-password-123" } }));
    const alice = users.authenticate("admin.test-2", "Alice-password-123");
    assert.ok(alice && !alice.isAdmin);
    bobToken = users.startSession(bob.id);
    aliceToken = users.startSession(alice.id);
    adminToken = users.startSession(adminUser.id);
  });

  await t("bootstrap never promotes an existing non-admin account that holds the email", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tenant-admin2-"));
    try {
      // Same process, new email: give bob's address to a fresh non-admin row via the DB API, then bootstrap.
      process.env.SWARM_ADMIN_EMAIL = "squat@example.com";
      users.createUser("squatter", "squatter-pass-123", false, "squat@example.com");
      const r = admin.bootstrapAdmin(log);
      assert.equal(r.status, "conflict");
      assert.equal(users.findUserByEmail("squat@example.com").isAdmin, false);
    } finally {
      process.env.SWARM_ADMIN_EMAIL = "Admin.Test@Example.com";
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  await t("Analytics: 403 for non-admins and signed-out requests; 200 with the numbers for the admin", async () => {
    assert.equal((await analytics.GET(req("/api/admin/analytics"))).status, 403);
    assert.equal((await analytics.GET(req("/api/admin/analytics", { token: bobToken }))).status, 403);
    assert.equal((await analytics.GET(req("/api/admin/analytics", { token: aliceToken }))).status, 403);
    const r = await analytics.GET(req("/api/admin/analytics", { token: adminToken }));
    assert.equal(r.status, 200);
    const a = await r.json();
    assert.equal(a.totalSignups, users.userCount());
    assert.equal(a.signupsPerDay.length, 30);
    assert.equal(a.signupsPerDay.at(-1).n, users.userCount(), "today's bar counts everyone created today");
    assert.ok(a.liveUsers >= 3, `live ${a.liveUsers}`);
    assert.ok(typeof a.running.tasks === "number" && typeof a.storage.total === "number");
    const row = a.users.find((u) => u.id === bob.id);
    assert.ok(row && row.storage.limit === 512 * 1024 * 1024 && !row.isAdmin);
    assert.ok(!JSON.stringify(a).includes("pw_hash") && !JSON.stringify(a).includes(ADMIN_PW));
  });

  await t("quota: 0.5 GB default, 5 GB for the admin, and only the admin can change one user's", async () => {
    assert.equal(st.storageLimit(bob.id), 512 * 1024 * 1024);
    assert.equal(st.storageLimit(adminUser.id), 5 * 1024 * 1024 * 1024);
    let r = await adminUsers.POST(req("/api/admin/users", { method: "POST", token: bobToken, body: { userId: bob.id, quotaMB: 100000 } }));
    assert.equal(r.status, 403, "bob can't raise his own quota");
    r = await adminUsers.POST(req("/api/admin/users", { method: "POST", token: adminToken, body: { userId: bob.id, quotaMB: 1024 } }));
    assert.equal(r.status, 200);
    assert.equal(st.storageLimit(bob.id), 1024 * 1024 * 1024);
    r = await adminUsers.POST(req("/api/admin/users", { method: "POST", token: adminToken, body: { userId: bob.id, quotaMB: -5 } }));
    assert.equal(r.status, 400);
    r = await adminUsers.POST(req("/api/admin/users", { method: "POST", token: adminToken, body: { userId: bob.id, quotaMB: null } }));
    assert.equal(st.storageLimit(bob.id), 512 * 1024 * 1024, "back to the default");
  });

  await t("delete user: admin only, needs the username, never an admin; removes the account, its logins and its data", async () => {
    const home = (await import("../lib/store.ts")).userHome;
    const bobHome = home(bob.id);
    fs.writeFileSync(path.join(bobHome, "note.txt"), "bob's data");
    const del = (token, body) => adminUsers.POST(req("/api/admin/users", { method: "POST", token, body: { action: "delete", ...body } }));
    assert.equal((await del(aliceToken, { userId: bob.id, confirm: "bob" })).status, 403, "a non-admin can't delete anyone");
    assert.equal((await del(adminToken, { userId: bob.id, confirm: "not-bob" })).status, 400, "wrong confirmation refused");
    assert.equal((await del(adminToken, { userId: adminUser.id, confirm: adminUser.username })).status, 409, "an admin can't be deleted");
    assert.ok(fs.existsSync(path.join(bobHome, "note.txt")), "nothing removed by refused calls");
    const r = await del(adminToken, { userId: bob.id, confirm: "BOB" });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(users.userById(bob.id), null, "account gone");
    assert.equal(users.userForToken(bobToken), null, "his login no longer works");
    assert.equal(users.authenticate("bob", "Bob-password-1234"), null, "can't sign in");
    assert.ok(!fs.existsSync(bobHome), "his files are gone");
    assert.equal((await del(adminToken, { userId: bob.id, confirm: "bob" })).status, 404, "second delete: no such user");
    assert.ok(users.userById(adminUser.id) && users.authenticate("admin-test-2", "x") === null);
  });

  console.log(`tenant-admin: ${pass}/${pass} pass`);
} catch (e) {
  console.error(`  FAIL after ${pass} passed:`, e?.message ?? e);
  process.exitCode = 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
