import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { configureUserPaths, consumePasswordResetToken, signupLocalUser } from "../../../../lib/users";
import { setMailTransportForTests, type MailMessage } from "../../../../lib/mailer";
import { configureAuditPath, readAuditEntries } from "../../../../lib/audit";

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json", host: "swarmagents.example.com", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let dir = "";
let sent: MailMessage[] = [];

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-reset-request-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  configureAuditPath(path.join(dir, "audit.jsonl"));
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  sent = [];
  setMailTransportForTests(async (message) => {
    sent.push(message);
    return { ok: true };
  });
  await signupLocalUser("alice@example.com", "correct horse battery staple");
});

test.afterEach(() => {
  setMailTransportForTests(null);
  configureUserPaths("");
  configureAuditPath(undefined);
  delete process.env.SWARM_SESSION_SECRET;
  delete process.env.SWARM_PUBLIC_ORIGIN;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Let the route's fire-and-forget mail send settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("POST /api/password-reset/request emails a working reset link for a known account", async () => {
  const res = await POST(request({ email: "ALICE@example.com" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("cache-control"), "no-store");

  await settle();
  assert.equal(sent.length, 1, "exactly one reset email is sent");
  assert.equal(sent[0].to, "alice@example.com");
  assert.match(sent[0].subject, /Reset your SwarmAgents password/);

  const m = /\/reset-password\?token=([^&\s]+)/.exec(sent[0].text);
  assert.ok(m, `reset link present in email body: ${sent[0].text}`);
  const token = decodeURIComponent(m[1]);
  // The emailed token is genuine: it consumes to the account.
  assert.equal(await consumePasswordResetToken(token), "alice@example.com");

  // The request is audited (server-side only; the caller learns nothing).
  const entries = readAuditEntries("anonymous").filter((e) => e.action === "password.reset.request");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result, "success");
});

test("POST /api/password-reset/request is not an account oracle", async () => {
  const known = await POST(request({ email: "alice@example.com" }));
  const unknown = await POST(request({ email: "nobody@example.com" }));
  const invalid = await POST(request({ email: "not-an-email" }));

  // Identical status and body for known, unknown and invalid emails.
  for (const res of [known, unknown, invalid]) {
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }

  await settle();
  assert.equal(sent.length, 1, "mail goes only to the real account");
  assert.equal(sent[0].to, "alice@example.com");
});

test("POST /api/password-reset/request rejects malformed bodies", async () => {
  assert.equal((await POST(request("not json"))).status, 400);
  assert.equal((await POST(request([]))).status, 400);
  // A well-formed body without an email is still a plain 200 (no oracle).
  assert.equal((await POST(request({}))).status, 200);
  await settle();
  assert.equal(sent.length, 0);
});

test("POST /api/password-reset/request prefers SWARM_PUBLIC_ORIGIN for the link", async () => {
  process.env.SWARM_PUBLIC_ORIGIN = "https://swarmagents.codes/";
  const res = await POST(request({ email: "alice@example.com" }));
  assert.equal(res.status, 200);
  await settle();
  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].text.includes("https://swarmagents.codes/reset-password?token=pr1."),
    `link uses the configured public origin: ${sent[0].text}`,
  );
});
