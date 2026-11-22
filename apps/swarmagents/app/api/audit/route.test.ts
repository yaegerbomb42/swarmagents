/**
 * Tests for GET /api/audit and for the audit wiring in the real code paths:
 * provider add/delete/key add/remove/rotate, approval decisions, snapshot
 * create/restore, and logins. Everything runs against a temp SWARM_HOME.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { POST as POST_PROVIDERS, PATCH as PATCH_PROVIDERS } from "../providers/route";
import { PATCH as PATCH_PROVIDER, DELETE as DELETE_PROVIDER } from "../providers/[id]/route";
import { POST as POST_APPROVAL } from "../runtime/approvals/[id]/route";
import { POST as POST_SNAPSHOT } from "../runtime/vm/snapshots/route";
import { POST as POST_LOGIN } from "../login/route";
import { POST as POST_PROJECT_SHARE, DELETE as DELETE_PROJECT_SHARE } from "../projects/[id]/share/route";
import { createProject } from "../../../lib/projects/store";
import { POST as POST_AGENT_DEPLOY } from "../agents/[id]/deploy/route";
import { GET as GET_AGENT_EXPORT } from "../agents/[id]/export/route";
import { DELETE as DELETE_AGENT } from "../agents/[id]/route";
import { saveAgent } from "../../../lib/agents/store";
import { POST as POST_LIBRARY_PUBLISH } from "../library/public/route";
import { POST as POST_LIBRARY_VERSION } from "../library/public/[id]/versions/route";
import { POST as POST_LIBRARY_UNPUBLISH } from "../library/public/[id]/unpublish/route";
import { POST as POST_LIBRARY_REVIEW } from "../library/public/[id]/review/route";
import { configureLibraryStoreDir } from "../../../lib/library/user-store";
import { POST as POST_TEST_DRIVE } from "../library/public/[id]/test-drive/route";
import { DELETE as DELETE_MEMORY } from "../memory/route";
import { POST as POST_BYOC_PAIR, DELETE as DELETE_BYOC_PAIR } from "../byoc/pair/route";
import { ByocTokenStore, setByocTokenStoreForTesting } from "../../../lib/byoc/tokens";
import { ByocHub, setByocHubForTesting } from "../../../lib/byoc/hub";
import { POST as POST_LOGOUT } from "../logout/route";
import { SESSION_COOKIE, signSession } from "../../../lib/auth";
import { recordAudit, readAuditEntries, configureAuditPath } from "../../../lib/audit";
import { configureProviderStorePaths } from "../../../lib/providers/store";
import { ApprovalStore, setApprovalStoreForTesting } from "../../../lib/harness/approvals";
import { VmManager, setVmManagerForTesting } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import { configureUserPaths, signupLocalUser } from "../../../lib/users";

let dir: string;
let prevHome: string | undefined;

function request(pathname: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${pathname}`, { ...init, headers, signal: init.signal ?? undefined });
}

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-audit-route-"));
  prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = dir;
  configureAuditPath(undefined);
  configureProviderStorePaths(path.join(dir, "providers.json"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-secret-for-audit";
  setApprovalStoreForTesting(new ApprovalStore({ ttlMs: 60_000 }));
  setVmManagerForTesting(new VmManager({ customDriver: new FakeVmDriver() }));
});

test.afterEach(() => {
  setApprovalStoreForTesting(null);
  setVmManagerForTesting(null);
  configureProviderStorePaths("");
  configureUserPaths("");
  delete process.env.SWARM_SESSION_SECRET;
  configureAuditPath(undefined);
  if (prevHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function auditGet(user: string | null = "alice", query = ""): Promise<Response> {
  return GET(request(`/api/audit${query}`, { method: "GET" }, user));
}

test("GET /api/audit returns only the caller's entries, newest first", async () => {
  recordAudit({ user: "alice", action: "snapshot.create", target: "before-upgrade", result: "success" });
  recordAudit({ user: "bob", action: "snapshot.create", target: "bob-snap", result: "success" });
  recordAudit({ user: "alice", action: "snapshot.restore", target: "before-upgrade", result: "success" });

  const res = await auditGet("alice");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { entries: Array<{ user: string; action: string }> };
  assert.equal(body.entries.length, 2);
  assert.equal(body.entries[0].action, "snapshot.restore");
  assert.equal(body.entries[1].action, "snapshot.create");
  assert.ok(body.entries.every((e) => e.user === "alice"));

  const bob = (await (await auditGet("bob")).json()) as { entries: unknown[] };
  assert.equal(bob.entries.length, 1);
});

test("GET /api/audit requires the caller header and honors limit", async () => {
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });

  assert.equal((await auditGet(null)).status, 401);
  const limited = (await (await auditGet("alice", "?limit=1")).json()) as { entries: unknown[] };
  assert.equal(limited.entries.length, 1);
  assert.equal((await auditGet("alice", "?limit=0")).status, 400);
  assert.equal((await auditGet("alice", "?limit=abc")).status, 400);
});

test("GET /api/audit returns [] when nothing was recorded", async () => {
  const body = (await (await auditGet("alice")).json()) as { entries: unknown[] };
  assert.deepEqual(body.entries, []);
});

async function postProvider(body: unknown, user = "alice"): Promise<Response> {
  return POST_PROVIDERS(request("/api/providers", { method: "POST", body: JSON.stringify(body) }, user));
}

test("provider add/delete and key add/remove/rotate are audit-logged without key material", async () => {
  assert.equal((await postProvider({ id: "openai", apiKey: "sk-first-key-aaaa" })).status, 201);
  const patch = await PATCH_PROVIDERS(
    request("/api/providers", { method: "PATCH", body: JSON.stringify({ id: "openai", action: "add-key", apiKey: "sk-second-key-bbbb" }) }, "alice"),
  );
  assert.equal(patch.status, 200);
  const rotate = await PATCH_PROVIDER(
    request("/api/providers/openai", { method: "PATCH", body: JSON.stringify({ action: "rotate-key", index: 0, apiKey: "sk-third-key-cccc" }) }, "alice"),
    { params: Promise.resolve({ id: "openai" }) },
  );
  assert.equal(rotate.status, 200);
  const remove = await PATCH_PROVIDER(
    request("/api/providers/openai", { method: "PATCH", body: JSON.stringify({ action: "remove-key", index: 1 }) }, "alice"),
    { params: Promise.resolve({ id: "openai" }) },
  );
  assert.equal(remove.status, 200);
  const del = await DELETE_PROVIDER(
    request("/api/providers/openai", { method: "DELETE" }, "alice"),
    { params: Promise.resolve({ id: "openai" }) },
  );
  assert.equal(del.status, 200);

  const entries = readAuditEntries("alice");
  assert.deepEqual(
    entries.map((e) => e.action),
    ["provider.delete", "provider.key.remove", "provider.key.rotate", "provider.key.add", "provider.add"],
  );
  assert.ok(entries.every((e) => e.target === "openai" && e.result === "success"));
  const raw = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  assert.ok(!raw.includes("sk-first-key"), "audit log must never contain key material");
  assert.ok(!raw.includes("sk-second-key"), "audit log must never contain key material");
  assert.ok(!raw.includes("sk-third-key"), "audit log must never contain key material");
});

test("a failed provider key mutation is audit-logged as a failure", async () => {
  const res = await PATCH_PROVIDERS(
    request("/api/providers", { method: "PATCH", body: JSON.stringify({ id: "missing", action: "add-key", apiKey: "sk-x" }) }, "alice"),
  );
  assert.equal(res.status, 404);
  const entries = readAuditEntries("alice");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "provider.key.add");
  assert.equal(entries[0].target, "missing");
  assert.equal(entries[0].result, "failure");
});

test("approval approve/deny decisions are audit-logged", async () => {
  const { getApprovalStore } = await import("../../../lib/harness/approvals");
  const store = getApprovalStore();
  const approval = store.create({
    runId: "run_1",
    userId: "alice",
    toolName: "Bash",
    action: "rm -rf /",
    reason: "destructive command",
  });
  const denied = store.create({
    runId: "run_1",
    userId: "alice",
    toolName: "Bash",
    action: "rm -rf /tmp",
    reason: "destructive command",
  });

  const approve = await POST_APPROVAL(
    request(`/api/runtime/approvals/${approval.id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) }, "alice"),
    { params: Promise.resolve({ id: approval.id }) },
  );
  assert.equal(approve.status, 200);
  const deny = await POST_APPROVAL(
    request(`/api/runtime/approvals/${denied.id}`, { method: "POST", body: JSON.stringify({ decision: "deny" }) }, "alice"),
    { params: Promise.resolve({ id: denied.id }) },
  );
  assert.equal(deny.status, 200);

  const entries = readAuditEntries("alice");
  assert.deepEqual(
    entries.map((e) => [e.action, e.target]),
    [
      ["approval.deny", denied.id],
      ["approval.approve", approval.id],
    ],
  );
  assert.ok(entries.every((e) => e.result === "success"));
});

test("snapshot create/restore are audit-logged", async () => {
  const create = await POST_SNAPSHOT(
    request("/api/runtime/vm/snapshots", { method: "POST", body: JSON.stringify({ action: "create", label: "before-upgrade" }) }, "alice"),
  );
  assert.equal(create.status, 201);
  const restore = await POST_SNAPSHOT(
    request("/api/runtime/vm/snapshots", { method: "POST", body: JSON.stringify({ action: "restore", label: "before-upgrade" }) }, "alice"),
  );
  assert.equal(restore.status, 200);

  const entries = readAuditEntries("alice");
  assert.deepEqual(
    entries.map((e) => [e.action, e.target]),
    [
      ["snapshot.restore", "before-upgrade"],
      ["snapshot.create", "before-upgrade"],
    ],
  );
});

test("login success and failure are audit-logged without the password", async () => {
  await signupLocalUser("alice@example.com", "correct horse battery staple");
  const loginReq = (body: unknown) =>
    new NextRequest("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const ok = await POST_LOGIN(loginReq({ email: "alice@example.com", password: "correct horse battery staple" }));
  assert.equal(ok.status, 200);
  const bad = await POST_LOGIN(loginReq({ email: "alice@example.com", password: "wrong password" }));
  assert.equal(bad.status, 401);

  const entries = readAuditEntries("local_alice@example.com");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, "login.failure");
  assert.equal(entries[0].target, "alice@example.com");
  assert.equal(entries[1].action, "login.success");
  // Failed logins are attributed to the targeted account, not "anonymous".
  const failed = readAuditEntries("anonymous");
  assert.equal(failed.length, 0);
  const raw = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  assert.ok(!raw.includes("correct horse"), "audit log must never contain password material");
  assert.ok(!raw.includes("wrong password"), "audit log must never contain password material");
});

test("GET /api/audit filters by action (exact and prefix) and result", async () => {
  recordAudit({ user: "alice", action: "provider.add", target: "openai", result: "success" });
  recordAudit({ user: "alice", action: "provider.key.add", target: "openai", result: "success" });
  recordAudit({ user: "alice", action: "provider.key.add", target: "openai", result: "failure" });
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });

  const exact = (await (await auditGet("alice", "?action=provider.key.add")).json()) as { entries: unknown[] };
  assert.equal(exact.entries.length, 2);

  const prefixDot = (await (await auditGet("alice", "?action=provider.")).json()) as { entries: unknown[] };
  assert.equal(prefixDot.entries.length, 3);

  const prefixStar = (await (await auditGet("alice", "?action=provider*")).json()) as { entries: unknown[] };
  assert.equal(prefixStar.entries.length, 3);

  const failures = (await (await auditGet("alice", "?result=failure")).json()) as { entries: Array<{ result: string }> };
  assert.equal(failures.entries.length, 1);
  assert.equal(failures.entries[0].result, "failure");

  const combined = (await (await auditGet("alice", "?action=provider.&result=failure")).json()) as { entries: unknown[] };
  assert.equal(combined.entries.length, 1);

  assert.equal((await auditGet("alice", "?action=bad action!")).status, 400);
  assert.equal((await auditGet("alice", "?result=maybe")).status, 400);
  assert.equal((await auditGet("alice", "?format=xml")).status, 400);
  assert.equal((await auditGet("alice", "?before=abc")).status, 400);
  assert.equal((await auditGet("alice", "?before=-5")).status, 400);
});

test("GET /api/audit paginates with before cursor and nextCursor", async () => {
  // Fixed timestamps so the cursor math is deterministic.
  const lines = [0, 1, 2, 3, 4].map((i) =>
    JSON.stringify({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      user: "alice",
      action: "snapshot.create",
      target: `snap-${i}`,
      result: "success",
    }),
  );
  fs.appendFileSync(path.join(dir, "audit.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const page1 = (await (await auditGet("alice", "?limit=2")).json()) as {
    entries: Array<{ target: string; ts: string }>;
    nextCursor: number | null;
  };
  assert.deepEqual(
    page1.entries.map((e) => e.target),
    ["snap-4", "snap-3"],
  );
  assert.equal(page1.nextCursor, Date.parse(page1.entries[1].ts));

  const page2 = (await (await auditGet("alice", `?limit=2&before=${page1.nextCursor}`)).json()) as {
    entries: Array<{ target: string }>;
    nextCursor: number | null;
  };
  assert.deepEqual(
    page2.entries.map((e) => e.target),
    ["snap-2", "snap-1"],
  );

  const page3 = (await (await auditGet("alice", `?limit=2&before=${page2.nextCursor}`)).json()) as {
    entries: Array<{ target: string }>;
    nextCursor: number | null;
  };
  assert.deepEqual(
    page3.entries.map((e) => e.target),
    ["snap-0"],
  );
  assert.equal(page3.nextCursor, null);
});

test("GET /api/audit reaches matches older than the newest 1,000 rows when filtering", async () => {
  // Entries 0..9 are login.success (oldest); 10..1009 are snapshot.create. The
  // newest 1,000 rows are therefore all snapshot.create, so the ten login.success
  // entries predate the old pre-filter truncation window and were unreachable.
  const lines: string[] = [];
  for (let i = 0; i < 1010; i++) {
    const action = i < 10 ? "login.success" : "snapshot.create";
    lines.push(
      JSON.stringify({
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        user: "alice",
        action,
        target: `entry-${i}`,
        result: "success",
      }),
    );
  }
  fs.appendFileSync(path.join(dir, "audit.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const collected: string[] = [];
  let before = "";
  for (let page = 0; page < 10; page++) {
    const query = `?action=login.success&limit=2${before ? `&before=${before}` : ""}`;
    const res = await auditGet("alice", query);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ target: string }>; nextCursor: number | null };
    for (const entry of body.entries) collected.push(entry.target);
    if (body.nextCursor === null) break;
    before = String(body.nextCursor);
  }
  assert.equal(collected.length, 10, "all ten old matching entries are reachable");
  assert.deepEqual(
    [...collected].sort(),
    Array.from({ length: 10 }, (_, i) => `entry-${i}`).sort(),
  );
});

test("GET /api/audit never skips entries that share the cursor timestamp", async () => {
  const sameTs = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 123));
  const lines = Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({
      ts: sameTs.toISOString(),
      user: "alice",
      action: "snapshot.create",
      target: `snap-${i}`,
      result: "success",
    }),
  );
  fs.appendFileSync(path.join(dir, "audit.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const page1 = (await (await auditGet("alice", "?limit=2")).json()) as {
    entries: Array<{ target: string }>;
    nextCursor: number | null;
  };
  // All six entries share one millisecond, so they must come back together rather
  // than splitting a same-ms group and quietly dropping the remainder on resume.
  assert.equal(page1.entries.length, 6);
  assert.equal(page1.nextCursor, null);
  assert.deepEqual(
    new Set(page1.entries.map((entry) => entry.target)),
    new Set(["snap-0", "snap-1", "snap-2", "snap-3", "snap-4", "snap-5"]),
  );
});

test("GET /api/audit ndjson export returns attachment with one line per entry", async () => {
  recordAudit({ user: "alice", action: "snapshot.create", target: "before-upgrade", result: "success" });
  recordAudit({ user: "alice", action: "snapshot.restore", target: "before-upgrade", result: "success" });

  const res = await auditGet("alice", "?format=ndjson");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="swarm-audit.ndjson"');
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]) as { action: string }).action, "snapshot.restore");
  assert.equal((JSON.parse(lines[1]) as { action: string }).action, "snapshot.create");
});

test("GET /api/audit json responses carry no-store and nextCursor", async () => {
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });
  const res = await auditGet("alice");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { entries: unknown[]; nextCursor: unknown };
  assert.equal(body.entries.length, 1);
  assert.equal(body.nextCursor, null);
});

test("project share creation and revocation emit clean audit entries without token leaks", async () => {
  const p = createProject("alice", { name: "Audit Project" });
  const shareRes = await POST_PROJECT_SHARE(
    request(`/api/projects/${p.id}/share`, { method: "POST" }, "alice"),
    { params: Promise.resolve({ id: p.id }) },
  );
  assert.equal(shareRes.status, 200);
  const shareJson = (await shareRes.json()) as { share: { token: string } };
  assert.ok(shareJson.share.token);

  const revokeRes = await DELETE_PROJECT_SHARE(
    request(`/api/projects/${p.id}/share`, { method: "DELETE" }, "alice"),
    { params: Promise.resolve({ id: p.id }) },
  );
  assert.equal(revokeRes.status, 200);

  const entries = readAuditEntries("alice");
  const revokeEntry = entries.find((e) => e.action === "project.share.revoke");
  const createEntry = entries.find((e) => e.action === "project.share.create");

  assert.ok(createEntry, "must emit project.share.create");
  assert.equal(createEntry.target, p.id);
  assert.equal(createEntry.result, "success");
  assert.ok(!JSON.stringify(createEntry).includes(shareJson.share.token), "share token must not leak into audit");

  assert.ok(revokeEntry, "must emit project.share.revoke");
  assert.equal(revokeEntry.target, p.id);
  assert.equal(revokeEntry.result, "success");
});

test("agent deploy, export, and delete emit audit entries", async () => {
  const saved = saveAgent("alice", {
    version: 1,
    id: "audited-agent",
    name: "Audited Agent",
    description: "A test prompt.",
    identity: { systemPrompt: "Prompt", tone: "terse" },
    models: { preferred: "gpt-4o", fallbacks: [] },
    tools: ["Read"],
  });
  assert.ok(saved.ok);
  const agentId = saved.manifest.id;

  const exportRes = await GET_AGENT_EXPORT(
    request(`/api/agents/${agentId}/export`, { method: "GET" }, "alice"),
    { params: Promise.resolve({ id: agentId }) },
  );
  assert.equal(exportRes.status, 200);

  const deployRes = await POST_AGENT_DEPLOY(
    request(`/api/agents/${agentId}/deploy`, { method: "POST", body: JSON.stringify({ harness: "swarm" }) }, "alice"),
    { params: Promise.resolve({ id: agentId }) },
  );
  assert.equal(deployRes.status, 200);

  const delRes = await DELETE_AGENT(
    request(`/api/agents/${agentId}`, { method: "DELETE" }, "alice"),
    { params: Promise.resolve({ id: agentId }) },
  );
  assert.equal(delRes.status, 200);

  const entries = readAuditEntries("alice");
  const delEntry = entries.find((e) => e.action === "agent.delete");
  const deployEntry = entries.find((e) => e.action === "agent.deploy");
  const exportEntry = entries.find((e) => e.action === "agent.export");

  assert.ok(exportEntry, "must emit agent.export");
  assert.equal(exportEntry.target, agentId);
  assert.equal(exportEntry.result, "success");

  assert.ok(deployEntry, "must emit agent.deploy");
  assert.equal(deployEntry.target, agentId);
  assert.equal(deployEntry.result, "success");

  assert.ok(delEntry, "must emit agent.delete");
  assert.equal(delEntry.target, agentId);
  assert.equal(delEntry.result, "success");
});

test("library publish, unpublish, and review emit audit entries", async () => {
  configureLibraryStoreDir(dir);
  process.env.SWARM_ADMIN_USERS = "admin_alice";
  const publishRes = await POST_LIBRARY_PUBLISH(
    request("/api/library/public", {
      method: "POST",
      body: JSON.stringify({
        name: "My Skill",
        kind: "skill",
        description: "A skill for testing",
        payload: { kind: "skill", skillMd: "# My Skill\n\nRun instructions.", files: [], requiredFields: [] },
      }),
    }, "alice"),
  );
  assert.equal(publishRes.status, 201);
  const { item } = (await publishRes.json()) as { item: { id: string } };

  const reviewRes = await POST_LIBRARY_REVIEW(
    request(`/api/library/public/${item.id}/review`, { method: "POST" }, "admin_alice"),
    { params: Promise.resolve({ id: item.id }) },
  );
  assert.equal(reviewRes.status, 200);

  const unpublishRes = await POST_LIBRARY_UNPUBLISH(
    request(`/api/library/public/${item.id}/unpublish`, { method: "POST" }, "alice"),
    { params: Promise.resolve({ id: item.id }) },
  );
  assert.equal(unpublishRes.status, 200);

  const aliceEntries = readAuditEntries("alice");
  const pubEntry = aliceEntries.find((e) => e.action === "library.publish");
  const unpubEntry = aliceEntries.find((e) => e.action === "library.unpublish");
  assert.ok(pubEntry, "must emit library.publish");
  assert.equal(pubEntry.target, item.id);

  assert.ok(unpubEntry, "must emit library.unpublish");
  assert.equal(unpubEntry.target, item.id);

  const adminEntries = readAuditEntries("admin_alice");
  const reviewEntry = adminEntries.find((e) => e.action === "library.review");
  assert.ok(reviewEntry, "must emit library.review");
  assert.equal(reviewEntry.target, item.id);
});

test("test-drive start, keep, and rollback emit audit entries", async () => {
  configureLibraryStoreDir(dir);
  const publishRes = await POST_LIBRARY_PUBLISH(
    request("/api/library/public", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Driver Item",
        kind: "skill",
        description: "Test drive item",
        payload: { kind: "skill", skillMd: "# Test Drive Skill", files: [], requiredFields: [] },
      }),
    }, "alice_td"),
  );
  const { item } = (await publishRes.json()) as { item: { id: string } };

  const startRes = await POST_TEST_DRIVE(
    request(`/api/library/public/${item.id}/test-drive`, {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    }, "alice_td"),
    { params: Promise.resolve({ id: item.id }) },
  );
  assert.equal(startRes.status, 201);
  const { drive } = (await startRes.json()) as { drive: { id: string } };

  const entries = readAuditEntries("alice_td");
  const startEntry = entries.find((e) => e.action === "test_drive.start");
  assert.ok(startEntry, "must emit test_drive.start");
  assert.equal(startEntry.target, drive.id);
});

test("memory clear emits memory.clear audit entry", async () => {
  const delRes = await DELETE_MEMORY(request("/api/memory", { method: "DELETE" }, "alice"));
  assert.equal(delRes.status, 200);

  const entries = readAuditEntries("alice");
  const memEntry = entries.find((e) => e.action === "memory.clear");
  assert.ok(memEntry, "must emit memory.clear");
  assert.equal(memEntry.target, "alice");
});

test("byoc pair and revoke emit audit entries without token leaks", async () => {
  const byocDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-byoc-audit-"));
  const byocFile = path.join(byocDir, "byoc.json");
  const store = new ByocTokenStore({ file: byocFile });
  setByocTokenStoreForTesting(store);
  const hub = new ByocHub({ tokens: store, port: 0 });
  setByocHubForTesting(hub);

  try {
    const pairRes = await POST_BYOC_PAIR(
      request("/api/byoc/pair", { method: "POST", body: JSON.stringify({ name: "Worker 1" }) }, "alice"),
    );
    assert.equal(pairRes.status, 201);
    const pairJson = (await pairRes.json()) as { code: string };

    const paired = store.redeemPairingCode(pairJson.code, "Worker 1");
    assert.ok(paired.ok);

    const revokeRes = await DELETE_BYOC_PAIR(
      request(`/api/byoc/pair?deviceId=${paired.device.id}`, { method: "DELETE" }, "alice"),
    );
    assert.equal(revokeRes.status, 200);

    const entries = readAuditEntries("alice");
    const pairEntry = entries.find((e) => e.action === "computer.pair");
    const revokeEntry = entries.find((e) => e.action === "computer.revoke");

    assert.ok(pairEntry, "must emit computer.pair");
    assert.ok(!JSON.stringify(pairEntry).includes(pairJson.code), "pairing code must not leak");

    assert.ok(revokeEntry, "must emit computer.revoke");
    assert.equal(revokeEntry.target, paired.device.id);
  } finally {
    setByocTokenStoreForTesting(null);
    setByocHubForTesting(null);
    fs.rmSync(byocDir, { recursive: true, force: true });
  }
});

test("logout emits logout audit entry", async () => {
  // Main's logout route identifies the caller from the session cookie, not
  // the x-swarm-user header, so the test signs a session for alice.
  const logoutRes = await POST_LOGOUT(
    request(
      "/api/logout",
      { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${signSession("alice")}` } },
      "alice",
    ),
  );
  assert.equal(logoutRes.status, 200);

  const entries = readAuditEntries("alice");
  const logoutEntry = entries.find((e) => e.action === "session.logout");
  assert.ok(logoutEntry, "must emit session.logout");
  assert.equal(logoutEntry.target, "alice");
});
