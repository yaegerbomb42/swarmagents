// Per-user storage quota (lib/tenant/storage.ts) and auto-prune (lib/tenant/prune.ts), in server mode with two
// accounts. Fills an account to its limit and checks: the 80/95/100% levels, writes and runs blocked at 100%,
// per-category and per-chat accounting, auto-prune order (screenshots → step detail → oldest chats), pinned and
// running chats never touched, clear-old-chats, per-chat delete, and that one account never affects another.
// Run: npx tsx tests/tenant-storage.mjs   (part of npm run test:tenant)
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tenant-storage-"));
process.env.SWARM_HOME = home;
process.env.SWARM_MODE = "server";
process.env.SWARM_STORAGE_QUOTA_MB = "1"; // 1 MiB per account keeps the test fast

const store = await import("../lib/store.ts");
const st = await import("../lib/tenant/storage.ts");
const pr = await import("../lib/tenant/prune.ts");
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const LIMIT = 1024 * 1024;
let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log("  ok", name);
};

/** A chat whose events carry `shots` screenshots of `kb` KB each, last used `daysAgo` days ago. */
function chat(title, { shots = 0, kb = 40, daysAgo = 0, archiveKb = 0, text = 2 } = {}) {
  // Built by hand: store.createSession() needs the per-user OS sandbox on a server, which this unit test doesn't run.
  const m = { id: store.newId(), title, createdAt: Date.now() - daysAgo * 86_400_000, updatedAt: Date.now() - daysAgo * 86_400_000, cwd: "/tmp" };
  fs.mkdirSync(store.sessionDir(m.id), { recursive: true });
  store.saveMeta(m);
  const img = { mediaType: "image/png", data: "A".repeat(kb * 1024) };
  const events = [{ id: "e0", ts: 1, type: "user", text: "hello" }];
  for (let i = 0; i < Math.max(shots, text); i++) events.push({ id: `t${i}`, ts: 2 + i, type: "tool", name: "browser", input: {}, status: "ok", output: `step ${i} result`, images: i < shots ? [img] : undefined });
  store.saveEvents(m.id, events);
  store.saveHistory(m.id, [{ role: "user", blocks: [{ type: "text", text: "hello" }] }]);
  if (archiveKb) fs.writeFileSync(path.join(store.sessionDir(m.id), "events-archive.jsonl"), Array.from({ length: 8 }, (_, i) => JSON.stringify({ id: `a${i}`, type: "tool", output: "x".repeat((archiveKb * 1024) / 8) })).join("\n") + "\n");
  st.invalidate();
  return m;
}

try {
  t("no context on a server throws instead of measuring shared storage", () => assert.throws(() => st.usage(), /No signed-in user/));

  let pinned, running, oldest, plain;
  store.runAs(A, () => {
    oldest = chat("oldest, screenshots", { shots: 6, daysAgo: 40 }); // ~240 KB of images
    pinned = chat("pinned, screenshots", { shots: 4, daysAgo: 50 });
    running = chat("running, screenshots", { shots: 4, daysAgo: 60 });
    plain = chat("trajectory heavy", { archiveKb: 160, daysAgo: 20 });
    pr.saveStorageSettings({ pinned: [pinned.id] });
    const m = store.getMeta(running.id);
    m.active = true; // a run in progress
    store.saveMeta(m);
  });

  t("usage is split by category and by chat", () =>
    store.runAs(A, () => {
      const u = st.usage(undefined, true);
      assert.ok(u.byCategory.chats > 500 * 1024, `chats ${u.byCategory.chats}`);
      assert.ok(u.byCategory.trajectories >= 160 * 1024, `trajectories ${u.byCategory.trajectories}`);
      assert.ok(u.sessions[oldest.id] > 240 * 1024 && u.sessions[plain.id] >= 160 * 1024);
      assert.equal(u.used, Object.values(u.byCategory).reduce((s, x) => s + x, 0));
    }));

  t("80% warns, 95% is critical", () =>
    store.runAs(A, () => {
      assert.equal(st.levelOf(0.79 * LIMIT, LIMIT), "ok");
      assert.equal(st.levelOf(0.8 * LIMIT, LIMIT), "warn");
      assert.equal(st.levelOf(0.95 * LIMIT, LIMIT), "critical");
      assert.equal(st.levelOf(LIMIT, LIMIT), "full");
      // Fill the real account: 85% → warn, 96% → critical, still writable below 100%.
      const ws = path.join(store.userHome(), "workspace");
      fs.mkdirSync(ws, { recursive: true });
      const fill = (pct) => {
        fs.rmSync(path.join(ws, "level.bin"), { force: true });
        st.invalidate();
        const need = Math.ceil(pct * LIMIT - st.usage(undefined, true).used);
        fs.writeFileSync(path.join(ws, "level.bin"), Buffer.alloc(Math.max(0, need)));
        st.invalidate();
        return st.usage(undefined, true);
      };
      let u = fill(0.85);
      assert.equal(st.levelOf(u.used, LIMIT), "warn", `at ${((u.used / LIMIT) * 100).toFixed(1)}%`);
      u = fill(0.96);
      assert.equal(st.levelOf(u.used, LIMIT), "critical", `at ${((u.used / LIMIT) * 100).toFixed(1)}%`);
      assert.equal(st.storageBlock(0), null, "still writable below 100%");
      fs.rmSync(path.join(ws, "level.bin"));
      st.invalidate();
    }));

  t("at 100% new writes and new runs are refused with a clear message; a running agent gets a small grace", () =>
    store.runAs(A, () => {
      const ws = path.join(store.userHome(), "workspace");
      fs.mkdirSync(ws, { recursive: true });
      const need = LIMIT - st.usage(undefined, true).used;
      fs.writeFileSync(path.join(ws, "filler.bin"), Buffer.alloc(need + 4096));
      st.invalidate();
      const e = st.storageBlock(0);
      assert.ok(e instanceof st.StorageFullError && e.status === 507);
      assert.match(e.message, /storage is full .*delete old chats.*auto-prune/i);
      assert.throws(() => st.assertStorage(10), st.StorageFullError);
      assert.equal(st.storageBlock(0, { grace: 0.5 }), null, "an in-flight run may finish saving its step");
      assert.equal(st.usage().byCategory.files >= need, true);
    }));

  t("writes reported between walks count immediately", () =>
    store.runAs(B, () => {
      st.usage(undefined, true);
      assert.equal(st.storageBlock(LIMIT / 2), null);
      st.noteWrite(LIMIT);
      assert.ok(st.storageBlock(0), "blocked right after a reported write, before any re-walk");
      st.invalidate();
      assert.equal(st.storageBlock(0), null, "the next walk sees B's real (tiny) usage");
    }));

  t("auto-prune is off by default: nothing is removed", () =>
    store.runAs(A, () => {
      assert.deepEqual(pr.maybeAutoPrune(st.usage(undefined, true)), []);
      assert.ok(store.getMeta(oldest.id));
    }));

  t("auto-prune frees screenshots first, keeps every step's text, never touches pinned or running chats", () =>
    store.runAs(A, () => {
      fs.rmSync(path.join(store.userHome(), "workspace", "filler.bin"));
      st.invalidate();
      // ~88% → over PRUNE_AT once a little more lands
      const ws = path.join(store.userHome(), "workspace");
      const need = Math.ceil(0.92 * LIMIT - st.usage(undefined, true).used);
      if (need > 0) fs.writeFileSync(path.join(ws, "keep.bin"), Buffer.alloc(need));
      pr.saveStorageSettings({ autoPrune: true });
      const done = pr.maybeAutoPrune(st.usage(undefined, true));
      assert.ok(done.length && done[0].kind === "screenshots" && done[0].auto, JSON.stringify(done));
      assert.ok(done.every((d) => d.sessionId !== pinned.id && d.sessionId !== running.id), "pinned/running untouched");
      const ev = store.loadEvents(oldest.id);
      assert.ok(ev.every((e) => !e.images) && ev.filter((e) => e.type === "tool").every((e) => /^step \d+ result$/.test(e.output)), "images gone, text kept");
      assert.ok(store.loadEvents(pinned.id).some((e) => e.images?.length), "pinned chat keeps its screenshots");
      assert.ok(store.loadEvents(running.id).some((e) => e.images?.length), "running chat keeps its screenshots");
      assert.ok(st.usage(undefined, true).used <= pr.PRUNE_TO * LIMIT, `pruned to ${Math.round((st.usage().used / LIMIT) * 100)}%`);
      assert.ok(pr.pruneLog().some((l) => l.kind === "screenshots" && l.freed > 100 * 1024), "the log shows what was pruned");
    }));

  t("when screenshots aren't enough: step detail is compacted, then the oldest chats go (pinned and running survive)", () =>
    store.runAs(A, () => {
      const ws = path.join(store.userHome(), "workspace");
      const need = Math.ceil(0.97 * LIMIT - st.usage(undefined, true).used);
      fs.writeFileSync(path.join(ws, "more.bin"), Buffer.alloc(Math.max(0, need)));
      const before = fs.statSync(path.join(store.sessionDir(plain.id), "events-archive.jsonl")).size;
      // Files can't be pruned, so with ~0.9 MB of files the chats have to go too.
      const done = pr.maybeAutoPrune(st.usage(undefined, true));
      const kinds = done.map((d) => d.kind);
      assert.ok(kinds.includes("trajectory") && kinds.includes("chat"), kinds.join(","));
      assert.ok(kinds.indexOf("trajectory") < kinds.indexOf("chat"), "compaction before deletion");
      const arch = path.join(store.sessionDir(plain.id), "events-archive.jsonl");
      if (fs.existsSync(arch)) {
        assert.ok(fs.statSync(arch).size < before);
        for (const l of fs.readFileSync(arch, "utf8").trim().split("\n")) JSON.parse(l); // still valid, line for line
      }
      assert.ok(store.getMeta(pinned.id), "pinned chat kept");
      assert.ok(store.getMeta(running.id), "running chat kept");
      assert.equal(store.getMeta(oldest.id), null, "oldest unpinned idle chat deleted");
    }));

  t("clear old chats and per-chat delete (refused for pinned/running chats)", () =>
    store.runAs(B, () => {
      const old1 = chat("b old", { daysAgo: 100 });
      const fresh = chat("b fresh", { daysAgo: 1 });
      const pin = chat("b pinned old", { daysAgo: 200 });
      pr.saveStorageSettings({ pinned: [pin.id] });
      const cleared = pr.clearOldChats(30);
      assert.deepEqual(cleared.map((c) => c.sessionId), [old1.id]);
      assert.ok(cleared[0].freed > 0);
      assert.ok(store.getMeta(fresh.id) && store.getMeta(pin.id));
      assert.equal(pr.deleteChat(pin.id).status, 409);
      const m = store.getMeta(fresh.id);
      m.active = true;
      store.saveMeta(m);
      assert.equal(pr.deleteChat(fresh.id).status, 409);
      m.active = false;
      store.saveMeta(m);
      assert.equal(pr.deleteChat(fresh.id).kind, "delete");
      assert.equal(store.getMeta(fresh.id), null);
    }));

  t("auto-prune on: a write or run near the limit prunes the least recently used data first instead of refusing", () =>
    store.runAs("cccccccccccccccc", () => {
      const stale = chat("stale, screenshots", { shots: 8, daysAgo: 30 }); // ~320 KB of images, least recently used
      const recent = chat("recent, screenshots", { shots: 3, daysAgo: 1 });
      const keep = chat("pinned, oldest", { shots: 3, daysAgo: 90 });
      pr.saveStorageSettings({ pinned: [keep.id] });
      const ws = path.join(store.userHome(), "workspace");
      fs.mkdirSync(ws, { recursive: true });
      const need = Math.ceil(LIMIT - st.usage(undefined, true).used) + 1024; // just over 100%
      fs.writeFileSync(path.join(ws, "fill.bin"), Buffer.alloc(need));
      st.invalidate();
      st.resetPressureThrottle();
      assert.ok(st.storageBlock(), "auto-prune off: refused at 100%");
      assert.equal(store.loadEvents(stale.id).filter((e) => e.images).length, 8, "off means nothing is removed");
      pr.saveStorageSettings({ autoPrune: true });
      st.resetPressureThrottle();
      assert.equal(st.storageBlock(), null, "auto-prune on: space was freed, so the write goes through");
      assert.equal(store.loadEvents(stale.id).filter((e) => e.images).length, 0, "the least recently used chat's screenshots went first");
      assert.equal(store.loadEvents(recent.id).filter((e) => e.images).length, 3, "a recently used chat is untouched while older data suffices");
      assert.equal(store.loadEvents(keep.id).filter((e) => e.images).length, 3, "pinned is never touched, however old");
      assert.ok(store.getMeta(stale.id) && store.getMeta(recent.id), "no chat deleted while screenshots were enough");
      const log = pr.pruneLog();
      assert.ok(log.length && log.every((l) => l.auto) && log[0].sessionId === stale.id, JSON.stringify(log));
      assert.ok(st.usage(undefined, true).used <= pr.PRUNE_TO * LIMIT);
    }));

  t("accounts are independent: A's prune and quota never touch B", () => {
    const aIds = store.runAs(A, () => store.listSessions().map((m) => m.id));
    store.runAs(B, () => {
      assert.ok(store.listSessions().every((m) => !aIds.includes(m.id)));
      assert.equal(pr.deleteChat(pinned.id).status, 404, "B can't delete A's chat");
      assert.equal(st.storageBlock(0), null);
    });
  });

  t("an admin quota or a per-user override replaces the default", () => {
    delete process.env.SWARM_STORAGE_QUOTA_MB;
    store.runAs(A, () => assert.equal(st.storageLimit(), 512 * 1024 * 1024));
    assert.equal(st.storageLimit("local"), Infinity, "no quota on a laptop");
    process.env.SWARM_STORAGE_QUOTA_MB = "1";
  });

  console.log(`tenant-storage: ${pass}/${pass} pass`);
} catch (e) {
  console.error(`  FAIL after ${pass} passed:`, e);
  process.exitCode = 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
