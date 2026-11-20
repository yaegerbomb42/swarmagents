import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AmbientEngine } from "./engine";
import { configureAmbientStore, readDeliveries, upsertRule } from "./store";
import type { AmbientRule } from "./types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-"));
configureAmbientStore(dir);

function rule(partial: Partial<AmbientRule> & Pick<AmbientRule, "id" | "kind">): AmbientRule {
  return {
    userId: "user_a",
    roleId: "main",
    prompt: "Investigate the trigger and write a short note.",
    toolAllowlist: ["Read", "Write"],
    enabled: true,
    ...partial,
  };
}

test("a webhook fires a fullAuto run and posts the Run Report", async () => {
  const started: { fullAuto?: boolean; toolAllowlist?: readonly string[]; roleId?: string }[] = [];
  const ensured: string[] = [];
  const engine = new AmbientEngine({
    ensureVm: async (userId) => {
      ensured.push(userId);
    },
    startRun: (_userId, input) => {
      started.push(input);
      return { accepted: true, runId: "run_webhook_1", queued: false };
    },
    readReport: () => ({ status: "finished", summary: "CI note written." }),
  });
  upsertRule(rule({ id: "hook1", kind: "webhook", webhookSecret: "sekret" }));
  const refused = await engine.acceptWebhook("user_a", "hook1", "nope");
  assert.equal(refused.fired, false);
  const fired = await engine.acceptWebhook("user_a", "hook1", "sekret");
  assert.equal(fired.fired, true);
  assert.equal(fired.runId, "run_webhook_1");
  assert.deepEqual(ensured, ["user_a"]);
  assert.equal(started[0]?.fullAuto, true);
  assert.deepEqual(started[0]?.toolAllowlist, ["Read", "Write"]);
  assert.equal(started[0]?.roleId, "main");
  const stored = (await import("./store")).getRule("user_a", "hook1");
  assert.ok(stored);
  const posted = await engine.postReport(stored, "run_webhook_1", "run.finished");
  assert.equal(posted.reportFound, true);
  assert.equal(posted.summary, "CI note written.");
  assert.equal(readDeliveries().at(-1)?.runId, "run_webhook_1");
});

test("Monday 08:00 cron fires once for that minute", async () => {
  const starts: string[] = [];
  const monday = new Date("2026-11-16T08:00:00.000Z");
  const engine = new AmbientEngine({
    now: () => monday,
    ensureVm: async () => undefined,
    startRun: () => {
      starts.push("run");
      return { accepted: true, runId: "run_cron_1", queued: false };
    },
  });
  upsertRule(rule({ id: "mon", kind: "cron", cron: "0 8 * * 1" }));
  const first = await engine.tickCron();
  const second = await engine.tickCron();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.fired, true);
  assert.equal(second.length, 0);
  assert.equal(starts.length, 1);
});

test("a watched file change wakes a run once per mtime", async () => {
  let mtime = 1_000;
  const starts: number[] = [];
  const engine = new AmbientEngine({
    ensureVm: async () => undefined,
    startRun: () => {
      starts.push(mtime);
      return { accepted: true, runId: "run_file", queued: false };
    },
    statFile: async () => mtime,
  });
  upsertRule(rule({ id: "notes", kind: "file", filePath: "inbox/note.txt" }));
  await engine.tickFiles();
  await engine.tickFiles();
  mtime = 2_000;
  await engine.tickFiles();
  assert.deepEqual(starts, [2_000]);
});

test("a failed GitHub check wakes a run once per head SHA", async () => {
  let sha = "abc123";
  const starts: string[] = [];
  const engine = new AmbientEngine({
    ensureVm: async () => undefined,
    startRun: () => {
      starts.push(sha);
      return { accepted: true, runId: `run_${sha}`, queued: false };
    },
    githubCi: async () => ({ sha, failed: true }),
  });
  upsertRule(rule({ id: "pr", kind: "github_pr_ci", githubRepo: "acme/widgets", githubPr: 14 }));
  await engine.tickGithub();
  await engine.tickGithub();
  sha = "def456";
  await engine.tickGithub();
  assert.deepEqual(starts, ["abc123", "def456"]);
});

test("a cron refused by startRun is not marked fired and retries next tick", async () => {
  const monday = new Date("2026-11-16T08:00:00.000Z");
  const starts: string[] = [];
  const engine = new AmbientEngine({
    now: () => monday,
    ensureVm: async () => undefined,
    startRun: () => {
      starts.push(`run_${starts.length + 1}`);
      // First attempt refused, second accepted.
      return starts.length === 1
        ? { accepted: false, runId: "", queued: false, error: "queue full" }
        : { accepted: true, runId: `run_${starts.length}`, queued: false };
    },
  });
  const pending = rule({ id: "cron_refused", kind: "cron", cron: "0 8 * * 1" });
  upsertRule(pending);

  const first = await engine.tickCron([pending]);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.fired, false);
  assert.match(first[0]?.error ?? "", /queue full/);
  // The refused minute must stay unmarked so the next tick can retry it.
  const afterRefusal = (await import("./store")).getRule("user_a", "cron_refused");
  assert.equal(afterRefusal?.lastCronBucket, undefined);

  const second = await engine.tickCron([pending]);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.fired, true);
  assert.deepEqual(starts, ["run_1", "run_2"]);

  // Now the bucket is marked, so the same minute does not fire a third time.
  const third = await engine.tickCron([pending]);
  assert.equal(third.length, 0);
});

test("a cron whose ensureVm throws is not marked fired and retries next tick", async () => {
  const monday = new Date("2026-11-16T08:00:00.000Z");
  let vmAttempts = 0;
  let starts = 0;
  const engine = new AmbientEngine({
    now: () => monday,
    ensureVm: async () => {
      vmAttempts += 1;
      if (vmAttempts === 1) throw new Error("vm boot failed");
    },
    startRun: () => {
      starts += 1;
      return { accepted: true, runId: `run_vm_${vmAttempts}`, queued: false };
    },
  });
  const pending = rule({ id: "cron_vm_fail", kind: "cron", cron: "0 8 * * 1" });
  upsertRule(pending);

  const first = await engine.tickCron([pending]);
  assert.equal(first[0]?.fired, false);
  assert.match(first[0]?.error ?? "", /vm boot failed/);
  assert.equal(
    (await import("./store")).getRule("user_a", "cron_vm_fail")?.lastCronBucket,
    undefined,
  );
  assert.equal(starts, 0);

  const second = await engine.tickCron([pending]);
  assert.equal(second[0]?.fired, true);
  assert.equal(starts, 1);
});

test("a GitHub check refused by startRun is not marked fired and retries the same SHA", async () => {
  const sha = "cafe01";
  let attempts = 0;
  const engine = new AmbientEngine({
    ensureVm: async () => undefined,
    startRun: () => {
      attempts += 1;
      return attempts === 1
        ? { accepted: false, runId: "", queued: false, error: "queue full" }
        : { accepted: true, runId: `run_${attempts}`, queued: false };
    },
    githubCi: async () => ({ sha, failed: true }),
  });
  const pending = rule({ id: "gh_refused", kind: "github_pr_ci", githubRepo: "acme/widgets", githubPr: 15 });
  upsertRule(pending);

  const first = await engine.tickGithub([pending]);
  assert.equal(first[0]?.fired, false);
  assert.equal(
    (await import("./store")).getRule("user_a", "gh_refused")?.githubFiredSha,
    undefined,
  );

  const second = await engine.tickGithub([pending]);
  assert.equal(second[0]?.fired, true);
  assert.equal(attempts, 2);

  // The SHA is recorded now, so the same red head does not fire again.
  const third = await engine.tickGithub([pending]);
  assert.equal(third.length, 0);
});
