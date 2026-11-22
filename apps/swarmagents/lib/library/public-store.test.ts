/**
 * The shared public catalog: publishing, versioning, browsing, installs
 * (copy, never a live link), reporting and moderation rules.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLibraryStoreDir, getStoredItem } from "./user-store";
import { LibraryError } from "./types";
import {
  authorHandleFor,
  findPublicItem,
  installPublicItem,
  latestVersion,
  listPublicItems,
  clampPublicListLimit,
  clampPublicListOffset,
  publicCatalogFilePath,
  publicItemDetail,
  publicItemSummary,
  publishItem,
  publishVersion,
  readPublicCatalog,
  reportPublicItem,
  reviewPublicItem,
  unpublishPublicItem,
  updateAvailableFor,
} from "./public-store";

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-library-public-"));
  configureLibraryStoreDir(dir);
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function skill(markdown = "# Skill") {
  return { kind: "skill" as const, skillMd: markdown, files: [], requiredFields: [] };
}

function tool(fields: Array<{ key: string; label: string }> = []) {
  return {
    kind: "tool" as const,
    language: "javascript" as const,
    code: "return 1;",
    inputSchema: { type: "object", properties: {} },
    requiredFields: fields,
    timeoutMs: 5000,
  };
}

function expectLibraryError(fn: () => unknown, status = 400, pattern?: RegExp): LibraryError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LibraryError, `expected LibraryError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected the call to throw");
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

// ---- publish ---------------------------------------------------------------

test("publishItem records an unreviewed v1 and exposes a client-safe summary", () => {
  const record = publishItem("local_alice@example.com", {
    kind: "skill",
    name: "  Deploy helper  ",
    description: "  Ship safely  ",
    license: "MIT",
    payload: skill("# Deploy"),
    changelog: "initial",
  });
  assert.match(record.id, /^pub_[A-Za-z0-9_-]{12}$/);
  assert.equal(record.ownerId, "local_alice@example.com");
  assert.equal(record.authorHandle, "alice");
  assert.equal(record.name, "Deploy helper");
  assert.equal(record.description, "Ship safely");
  assert.equal(record.currentVersion, 1);
  assert.equal(record.moderation, "unreviewed");
  assert.equal(record.installs, 0);
  assert.deepEqual(record.versions.map((version) => version.version), [1]);
  assert.equal(record.versions[0].changelog, "initial");

  const summary = publicItemSummary(record);
  assert.equal(summary.version, 1);
  assert.equal(summary.reported, false);
  assert.equal(summary.reportCount, 0);
  // The publisher id is a server-only field.
  assert.equal(JSON.stringify(summary).includes("local_alice@example.com"), false);
});

test("publishItem validates owner, kind, name and optional text", () => {
  expectLibraryError(() => publishItem("", { kind: "skill", name: "x", payload: skill() }), 401, /signed-in/);
  expectLibraryError(() => publishItem("a", { kind: "nope" as any, name: "x", payload: skill() }), 400, /kind/);
  expectLibraryError(() => publishItem("a", { kind: "skill", name: "  ", payload: skill() }), 400, /name is required/);
  expectLibraryError(() => publishItem("a", { kind: "skill", name: "x".repeat(121), payload: skill() }), 400, /at most 120/);
  expectLibraryError(
    () => publishItem("a", { kind: "skill", name: "x", description: 1 as unknown as string, payload: skill() }),
    400,
    /description/,
  );
  expectLibraryError(
    () => publishItem("a", { kind: "skill", name: "x", license: "x".repeat(81), payload: skill() }),
    400,
    /license/,
  );
  expectLibraryError(() => publishItem("a", { kind: "skill", name: "x", payload: { kind: "tool" } }), 400, /kind must match/);
});

test("authorHandleFor strips local_ prefixes, domains and unsafe characters", () => {
  assert.equal(authorHandleFor("local_alice@example.com"), "alice");
  assert.equal(authorHandleFor("Alice@Example.COM"), "Alice");
  assert.equal(authorHandleFor("  user name!!  "), "user-name");
  assert.equal(authorHandleFor("..."), "anonymous");
  assert.equal(authorHandleFor(""), "anonymous");
  assert.equal(authorHandleFor("x".repeat(200)).length, 80);
});

// ---- versions --------------------------------------------------------------

test("publishVersion bumps the version and can update metadata", async () => {
  const first = publishItem("alice", { kind: "skill", name: "Mine", payload: skill("# v1") });
  await pause();
  const second = publishVersion(first.id, "alice", {
    kind: "skill",
    name: "Mine renamed",
    description: "now documented",
    license: "Apache-2.0",
    payload: skill("# v2"),
    changelog: "fix a typo",
  });
  assert.equal(second.currentVersion, 2);
  assert.equal(second.name, "Mine renamed");
  assert.equal(second.description, "now documented");
  assert.equal(second.license, "Apache-2.0");
  assert.equal(latestVersion(second).version, 2);
  assert.equal((latestVersion(second).payload as any).skillMd, "# v2");
  assert.equal(latestVersion(second).changelog, "fix a typo");
});

test("publishVersion refuses unknown items, other publishers and unpublished items", () => {
  const record = publishItem("alice", { kind: "skill", name: "Mine", payload: skill() });
  expectLibraryError(() => publishVersion("pub_missing", "alice", { kind: "skill", name: "x", payload: skill() }), 404, /not found/i);
  expectLibraryError(() => publishVersion(record.id, "bob", { kind: "skill", name: "x", payload: skill() }), 403, /publisher/);
  unpublishPublicItem(record.id, "alice", { admin: false });
  expectLibraryError(() => publishVersion(record.id, "alice", { kind: "skill", name: "x", payload: skill() }), 409, /unpublished/);
});

test("publishVersion caps stored history while keeping the current version resolvable", () => {
  const record = publishItem("alice", { kind: "skill", name: "Long", payload: skill("# 1") });
  for (let version = 2; version <= 105; version += 1) {
    publishVersion(record.id, "alice", { kind: "skill", name: "", payload: skill(`# ${version}`) });
  }
  const stored = findPublicItem(record.id)!;
  assert.equal(stored.currentVersion, 105);
  assert.ok(stored.versions.length <= 100);
  assert.equal(latestVersion(stored).version, 105);
});

// ---- browsing --------------------------------------------------------------

test("listPublicItems filters, searches, sorts and paginates without leaking unpublished items", async () => {
  const alpha = publishItem("alice", { kind: "skill", name: "Alpha", description: "first", payload: skill("#a") });
  await pause();
  const beta = publishItem("bob", { kind: "tool", name: "Beta", description: "second", payload: tool() });
  await pause();
  const gamma = publishItem("carol", { kind: "skill", name: "Gamma", description: "third", payload: skill("#g") });
  unpublishPublicItem(gamma.id, "carol", { admin: false });

  assert.equal(listPublicItems({}).total, 2);
  assert.deepEqual(listPublicItems({ kind: "tool" }).items.map((item) => item.name), ["Beta"]);
  assert.deepEqual(listPublicItems({ query: "third" }).items, [], "unpublished matches stay hidden");
  assert.deepEqual(listPublicItems({ query: "second" }).items.map((item) => item.name), ["Beta"]);
  assert.deepEqual(listPublicItems({ query: "alice" }).items.map((item) => item.name), ["Alpha"]);
  assert.deepEqual(listPublicItems({ sort: "name" }).items.map((item) => item.name), ["Alpha", "Beta"]);
  assert.deepEqual(listPublicItems({ sort: "newest" }).items.map((item) => item.name), ["Beta", "Alpha"]);
  assert.deepEqual(listPublicItems({ sort: "updated" }).items.map((item) => item.name), ["Beta", "Alpha"]);

  // installs: Beta has two unique installers, Alpha one.
  installPublicItem(beta.id, "u1", {});
  installPublicItem(beta.id, "u2", {});
  installPublicItem(alpha.id, "u1", {});
  assert.deepEqual(listPublicItems({ sort: "installs" }).items.map((item) => item.name), ["Beta", "Alpha"]);

  const page = listPublicItems({ sort: "name", limit: 1, offset: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map((item) => item.name), ["Beta"]);
});

test("clampPublicListLimit / offset bound negative and huge values", () => {
  assert.equal(clampPublicListLimit(-1), 1);
  assert.equal(clampPublicListLimit(1_000_000), 100);
  assert.equal(clampPublicListLimit(Number.NaN), 50);
  assert.equal(clampPublicListOffset(-5), 0);
  assert.equal(clampPublicListOffset("3.9"), 3);

  for (let i = 0; i < 5; i++) {
    publishItem("alice", { kind: "skill", name: `P${i}`, payload: skill(`#${i}`) });
  }
  const neg = listPublicItems({ sort: "name", limit: -1, offset: -10 });
  assert.equal(neg.items.length, 1, "limit=-1 clamps to 1");
  assert.equal(neg.total, 5);
  const huge = listPublicItems({ sort: "name", limit: 1_000_000, offset: 0 });
  assert.equal(huge.items.length, 5, "limit=1000000 clamps to 100 but only 5 exist");
});

test("unpublished visibility is consistent between list and detail for owner/admin", () => {
  const record = publishItem("alice", { kind: "skill", name: "Withdrawn", payload: skill("#w") });
  unpublishPublicItem(record.id, "alice", { admin: false });

  // Anonymous / other viewers: hidden in both list and detail gate.
  assert.equal(listPublicItems({}).items.find((i) => i.id === record.id), undefined);
  assert.equal(listPublicItems({ viewerId: "bob" }).items.find((i) => i.id === record.id), undefined);

  // Owner sees it in the list (same as detail).
  const ownerList = listPublicItems({ viewerId: "alice", sort: "name" });
  assert.ok(ownerList.items.some((i) => i.id === record.id), "owner list includes unpublished");
  const fresh = findPublicItem(record.id)!;
  const ownerDetail = publicItemDetail(fresh, "alice", false);
  assert.equal(ownerDetail.isOwner, true);

  // Admin also sees unpublished in the list.
  assert.ok(
    listPublicItems({ viewerId: "mod", admin: true }).items.some((i) => i.id === record.id),
    "admin list includes unpublished",
  );
});

test("publicItemDetail marks ownership and moderation capability", () => {
  const record = publishItem("alice", { kind: "skill", name: "Owned", payload: skill("# owned") });
  const owner = publicItemDetail(record, "alice", false);
  assert.equal(owner.isOwner, true);
  assert.equal(owner.canUnpublish, true);
  assert.deepEqual(owner.requiredFields, []);

  const other = publicItemDetail(record, "bob", false);
  assert.equal(other.isOwner, false);
  assert.equal(other.canUnpublish, false);

  const admin = publicItemDetail(record, "bob", true);
  assert.equal(admin.canUnpublish, true);

  (owner.payload as any).skillMd = "# mutated";
  assert.equal((record.versions[0].payload as any).skillMd, "# owned", "detail returns a copy");
});

// ---- installs --------------------------------------------------------------

test("installPublicItem copies the current version into the installer's library", () => {
  const record = publishItem("alice", {
    kind: "skill",
    name: "Copied",
    description: "copy me",
    license: "MIT",
    payload: skill("# v1"),
  });
  const result = installPublicItem(record.id, "bob", {});
  assert.equal(result.item.origin, "public");
  assert.equal(result.item.sourcePublicId, record.id);
  assert.equal(result.item.version, 1);
  assert.equal(result.item.name, "Copied");
  assert.equal(result.item.description, "copy me");
  assert.equal(result.item.license, "MIT");
  assert.equal((result.item.payload as any).skillMd, "# v1");
  assert.equal(result.publicItem.installs, 1);

  const stored = getStoredItem("bob", result.item.id)!;
  assert.equal(stored.sourcePublicId, record.id);
});

test("installPublicItem requires the installer's own secret values", () => {
  const record = publishItem("alice", {
    kind: "tool",
    name: "Needs a key",
    payload: tool([{ key: "TOKEN", label: "Token" }]),
  });
  const missing = expectLibraryError(() => installPublicItem(record.id, "bob", {}), 400, /Missing required secret/);
  assert.deepEqual(missing.details, { missingFields: ["TOKEN"] });

  const installed = installPublicItem(record.id, "bob", { TOKEN: "bob-test-value-1234" });
  assert.equal(installed.item.secretFields[0].configured, true);
  assert.equal(JSON.stringify(installed.item).includes("bob-test-value-1234"), false);
});

test("installPublicItem counts unique installs and treats a re-install as an update", async () => {
  const record = publishItem("alice", { kind: "skill", name: "Counted", payload: skill("# v1") });
  installPublicItem(record.id, "bob", {});
  installPublicItem(record.id, "bob", {});
  assert.equal(findPublicItem(record.id)!.installs, 1, "the same account installs once");
  installPublicItem(record.id, "carol", {});
  assert.equal(findPublicItem(record.id)!.installs, 2);

  await pause();
  publishVersion(record.id, "alice", { kind: "skill", name: "", payload: skill("# v2") });
  const updated = installPublicItem(record.id, "bob", {});
  assert.equal(updated.item.version, 2);
  assert.equal((updated.item.payload as any).skillMd, "# v2");
  assert.equal(findPublicItem(record.id)!.installs, 2, "updating does not inflate the count");
});

test("installPublicItem refuses unknown and unpublished items", () => {
  expectLibraryError(() => installPublicItem("pub_missing", "bob", {}), 404, /not found/i);
  const record = publishItem("alice", { kind: "skill", name: "Gone", payload: skill() });
  unpublishPublicItem(record.id, "alice", { admin: false });
  expectLibraryError(() => installPublicItem(record.id, "bob", {}), 404, /not found/i);
});

// ---- reports / moderation --------------------------------------------------

test("reportPublicItem keeps one report per account and hides reporter ids", () => {
  const record = publishItem("alice", { kind: "skill", name: "Reported", payload: skill() });
  expectLibraryError(() => reportPublicItem(record.id, "", "bad"), 401, /signed-in/);
  expectLibraryError(() => reportPublicItem("pub_missing", "bob", "bad"), 404, /not found/i);
  expectLibraryError(() => reportPublicItem(record.id, "bob", "   "), 400, /reason is required/);
  expectLibraryError(() => reportPublicItem(record.id, "bob", "x".repeat(501)), 400, /at most 500/);

  assert.equal(reportPublicItem(record.id, "bob", "spam").reportCount, 1);
  assert.equal(reportPublicItem(record.id, "bob", "spam again").reportCount, 1, "one report per account");
  assert.equal(reportPublicItem(record.id, "carol", "unsafe").reportCount, 2);

  const summary = listPublicItems({}).items[0];
  assert.equal(summary.reported, true);
  assert.equal(summary.reportCount, 2);
  assert.equal(JSON.stringify(summary).includes("bob"), false);
});

test("unpublishPublicItem is owner-or-admin and hides the item from browse", () => {
  const record = publishItem("alice", { kind: "skill", name: "Withdraw", payload: skill() });
  expectLibraryError(() => unpublishPublicItem(record.id, "", { admin: false }), 401, /signed-in/);
  expectLibraryError(() => unpublishPublicItem("pub_missing", "bob", { admin: false }), 404, /not found/i);
  expectLibraryError(() => unpublishPublicItem(record.id, "bob", { admin: false }), 403, /administrator/);

  const withdrawn = unpublishPublicItem(record.id, "alice", { admin: false });
  assert.equal(withdrawn.moderation, "unpublished");
  assert.equal(listPublicItems({}).total, 0);
  assert.equal(findPublicItem(record.id)!.moderation, "unpublished");

  // An admin may also withdraw someone else's item.
  const second = publishItem("bob", { kind: "skill", name: "Admin target", payload: skill() });
  assert.equal(unpublishPublicItem(second.id, "admin", { admin: true }).moderation, "unpublished");
});

test("reviewPublicItem is admin-only and cannot revive an unpublished item", () => {
  const record = publishItem("alice", { kind: "skill", name: "Review me", payload: skill() });
  expectLibraryError(() => reviewPublicItem(record.id, "alice", { admin: false }), 403, /administrator/);
  assert.equal(reviewPublicItem(record.id, "admin", { admin: true }).moderation, "reviewed");
  expectLibraryError(() => reviewPublicItem("pub_missing", "admin", { admin: true }), 404, /not found/i);

  unpublishPublicItem(record.id, "admin", { admin: true });
  expectLibraryError(() => reviewPublicItem(record.id, "admin", { admin: true }), 409, /unpublished/);
});

test("updateAvailableFor only reports a newer, still-public version", async () => {
  const record = publishItem("alice", { kind: "skill", name: "Updates", payload: skill("# v1") });
  assert.deepEqual(updateAvailableFor({ version: 1 }), { updateAvailable: false });
  assert.deepEqual(updateAvailableFor({ sourcePublicId: "pub_missing", version: 1 }), { updateAvailable: false });
  assert.deepEqual(updateAvailableFor({ sourcePublicId: record.id, version: 1 }), {
    updateAvailable: false,
    latestVersion: 1,
  });

  await pause();
  publishVersion(record.id, "alice", { kind: "skill", name: "", payload: skill("# v2") });
  assert.deepEqual(updateAvailableFor({ sourcePublicId: record.id, version: 1 }), {
    updateAvailable: true,
    latestVersion: 2,
  });
  assert.deepEqual(updateAvailableFor({ sourcePublicId: record.id, version: 2 }), {
    updateAvailable: false,
    latestVersion: 2,
  });

  unpublishPublicItem(record.id, "alice", { admin: false });
  assert.deepEqual(updateAvailableFor({ sourcePublicId: record.id, version: 1 }), { updateAvailable: false });
});

// ---- catalog hardening -----------------------------------------------------

test("readPublicCatalog tolerates corrupt files and drops invalid records/versions", () => {
  const file = publicCatalogFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json");
  assert.deepEqual(readPublicCatalog().items, []);

  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: "custom",
      version: 1,
      items: [
        {
          id: "legacy",
          kind: "skill",
          ownerId: "local_alice@example.com",
          name: "Legacy",
          currentVersion: 2,
          moderation: "nonsense",
          reports: [{ userId: "reporter", reason: "bad", at: 1 }],
          versions: [
            { version: 1, payload: skill("# v1") },
            { version: 2, payload: skill("# v2"), changelog: "c" },
          ],
          installerIds: ["bob"],
        },
        { id: "no-versions", kind: "skill", versions: [] },
        { id: "bad-version", kind: "skill", versions: [{ version: 1, payload: {} }] },
        { id: "bad-kind", kind: "nope", versions: [{ version: 1, payload: skill() }] },
      ],
    }),
  );
  const catalog = readPublicCatalog();
  assert.equal(catalog.items.length, 1);
  const legacy = catalog.items[0];
  assert.equal(legacy.id, "legacy");
  assert.equal(legacy.authorHandle, "alice");
  assert.equal(legacy.moderation, "unreviewed");
  assert.equal(legacy.currentVersion, 2);
  assert.equal(legacy.reports.length, 1);
  assert.deepEqual(legacy.versions.map((version) => version.version), [1, 2]);
  assert.equal(legacy.installs, 0);
});
