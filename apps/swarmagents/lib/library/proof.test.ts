/**
 * F4 — signed proof-of-run bundles: sign/verify, version binding, tamper
 * resistance, publish attachment, and the proof-shots route.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLibraryStoreDir } from "./user-store";
import { configureRunsDir } from "../telemetry/paths";
import { writeRunReport, writeShotFile } from "../runtime/run-report";
import type { RunReport } from "../runtime/run-report-types";
import {
  buildProofBundle,
  parseProofBundle,
  proofSecret,
  verifyProofBundle,
  type ProofBundle,
} from "./proof";
import {
  attachProofToCurrentVersion,
  findPublicItem,
  publicItemDetail,
  publishItem,
  publishVersion,
} from "./public-store";
import { GET as detailGET } from "../../app/api/library/public/[id]/route";
import { POST as publicPOST } from "../../app/api/library/public/route";
import { GET as shotGET } from "../../app/api/library/public/[id]/proof/shots/[index]/route";
import { resetPublishRateLimit } from "./rate";

let libDir: string;
let runsDir: string;
let savedEnv: NodeJS.ProcessEnv;

test.beforeEach(() => {
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-proof-lib-"));
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-proof-runs-"));
  configureLibraryStoreDir(libDir);
  configureRunsDir(runsDir);
  savedEnv = { ...process.env };
  process.env.SWARM_SESSION_SECRET = "test-proof-secret-do-not-use";
  process.env.SWARM_LIBRARY_PUBLISH_PER_HOUR = "1000";
  delete process.env.SWARM_ADMIN_USERS;
  delete process.env.SWARM_SERVER_MODE;
  resetPublishRateLimit();
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  configureRunsDir(null);
  resetPublishRateLimit();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(libDir, { recursive: true, force: true });
  fs.rmSync(runsDir, { recursive: true, force: true });
});

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";

function skillPayload(markdown = "# Deploy\n\nRun the checks.") {
  return { kind: "skill" as const, skillMd: markdown, files: [], requiredFields: [] };
}

function fakeReport(overrides: Partial<RunReport> = {}): RunReport {
  const now = Date.now();
  return {
    runId: "run_proof_1",
    userId: ALICE,
    status: "finished",
    prompt: "Deploy the thing",
    createdAt: now - 60_000,
    finishedAt: now,
    couldNotDo: [],
    steps: [
      { seq: 1, ts: now - 59_000, kind: "start", text: "Run started" },
      { seq: 2, ts: now - 30_000, kind: "tool", text: "Using Bash", ok: true },
      { seq: 3, ts: now, kind: "end", text: "Finished · exit 0" },
    ],
    artifacts: [
      { path: "/workspace/out.txt", rel: "out.txt", size: 12, mtimeMs: now, change: "created" },
    ],
    shots: [
      { file: "000.png", mime: "image/png", seq: 0, ts: now - 60_000, label: "Start", size: 8 },
      { file: "001.png", mime: "image/png", seq: 3, ts: now, label: "End", size: 8 },
    ],
    meta: {
      status: "finished",
      steps: 3,
      shots: 2,
      artifacts: 1,
      durationMs: 60_000,
      costUsd: 0.0123,
      providers: ["test-provider"],
      model: "test-model",
    },
    ...overrides,
  };
}

/** Persist a report (+ its shot bytes) the way the runtime would. */
function storeReport(report: RunReport): void {
  writeRunReport(report.runId, report);
  for (const shot of report.shots) {
    writeShotFile(report.runId, shot, Buffer.from("png-bytes"));
  }
}

function buildBundle(report: RunReport = fakeReport(), extra: Record<string, unknown> = {}): ProofBundle {
  const payload = skillPayload();
  storeReport(report);
  void extra;
  return buildProofBundle({
    publicId: "pub_test",
    version: 1,
    kind: "skill",
    name: "Deploy helper",
    payload,
    report,
    runsDir,
  }).bundle;
}

function publishSkillAs(user: string, body: Record<string, unknown>) {
  return publicPOST(
    new Request("http://localhost/api/library/public", {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-user": user },
      body: JSON.stringify(body),
    }),
  );
}

async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

function getDetail(user: string, id: string) {
  return detailGET(
    new Request(`http://localhost/api/library/public/${id}`, {
      headers: { "x-swarm-user": user },
    }),
    { params: Promise.resolve({ id }) },
  );
}

// ---- signing / verification -------------------------------------------------

test("a signed bundle verifies against the exact version and payload", () => {
  assert.ok(proofSecret().length > 0);
  const bundle = buildBundle();
  assert.equal(bundle.vmImage, "swarm-vm:claude");
  assert.equal(bundle.runStatus, "finished");
  assert.equal(bundle.shots.length, 2);
  assert.equal(bundle.shotsTotal, 2);
  assert.equal(bundle.costUsd, 0.0123);
  assert.ok(
    verifyProofBundle(bundle, { publicId: "pub_test", version: 1, payload: skillPayload() }),
  );
});

test("verification fails when the payload, version, id or contents are tampered with", () => {
  const bundle = buildBundle();
  const expected = { publicId: "pub_test", version: 1, payload: skillPayload() };
  assert.ok(verifyProofBundle(bundle, expected));
  // Different payload (one character) -> payload hash mismatch.
  assert.equal(
    verifyProofBundle(bundle, { ...expected, payload: skillPayload("# Deploy!\n\nRun the checks.") }),
    false,
  );
  // Different version -> binding mismatch.
  assert.equal(verifyProofBundle(bundle, { ...expected, version: 2 }), false);
  // Different public id -> binding mismatch.
  assert.equal(verifyProofBundle(bundle, { ...expected, publicId: "pub_other" }), false);
  // Tampered cost inside the bundle -> HMAC mismatch.
  assert.equal(verifyProofBundle({ ...bundle, costUsd: 0.0001 }, expected), false);
  // Tampered artifact -> HMAC mismatch.
  assert.equal(
    verifyProofBundle(
      { ...bundle, artifacts: [{ path: "/workspace/evil.txt", rel: "evil.txt", size: 1, mtimeMs: 0, change: "created" as const }] },
      expected,
    ),
    false,
  );
  // Missing signature -> never verified.
  const { signature: _sig, ...unsigned } = bundle;
  assert.equal(verifyProofBundle(unsigned, expected), false);
  // Garbage -> never verified, never throws.
  assert.equal(verifyProofBundle(null, expected), false);
  assert.equal(verifyProofBundle("signed", expected), false);
  assert.equal(parseProofBundle(bundle), bundle);
  assert.equal(parseProofBundle({ ...bundle, format: "other/v1" }), null);
});

test("signing refuses an empty server secret and verification fails without it", () => {
  delete process.env.SWARM_SESSION_SECRET;
  assert.equal(proofSecret(), "");
  assert.throws(() => buildBundle(), /SWARM_SESSION_SECRET/);
  process.env.SWARM_SESSION_SECRET = "test-proof-secret-do-not-use";
  const bundle = buildBundle();
  process.env.SWARM_SESSION_SECRET = "a-different-secret";
  assert.equal(
    verifyProofBundle(bundle, { publicId: "pub_test", version: 1, payload: skillPayload() }),
    false,
  );
  delete process.env.SWARM_SESSION_SECRET;
  assert.equal(
    verifyProofBundle(bundle, { publicId: "pub_test", version: 1, payload: skillPayload() }),
    false,
  );
});

test("only a finished run can be bundled as proof", () => {
  const failed = fakeReport({ status: "error" });
  assert.throws(() => buildBundle(failed), /Only a finished run/);
  const cancelled = fakeReport({ status: "cancelled" });
  assert.throws(() => buildBundle(cancelled), /Only a finished run/);
});

test("shot sampling caps stored screenshots and skips oversized ones", () => {
  // 9 shots on disk; shot 1 is oversized (it IS in the sampled set, so the
  // size cap — not sampling — must be what drops it).
  const report = fakeReport({
    shots: Array.from({ length: 9 }, (_, i) => ({
      file: `${String(i).padStart(3, "0")}.png`,
      mime: "image/png",
      seq: i,
      ts: 0,
      label: `shot ${i}`,
      size: i === 1 ? 2 * 1024 * 1024 : 8,
    })),
  });
  storeReport(report);
  const { bundle } = buildProofBundle({
    publicId: "pub_test",
    version: 1,
    kind: "skill",
    name: "Deploy helper",
    payload: skillPayload(),
    report,
    runsDir,
  });
  assert.equal(bundle.shotsTotal, 9);
  assert.equal(bundle.shots.length, 7);
  assert.ok(!bundle.shots.some((shot) => shot.label === "shot 1"));
});

// ---- publish attachment -----------------------------------------------------

test("publish with a finished run attaches a verified badge; shots serve", async () => {
  const report = fakeReport();
  storeReport(report);
  const res = await publishSkillAs(ALICE, {
    kind: "skill",
    name: "Deploy helper",
    description: "Ship safely",
    license: "MIT",
    payload: skillPayload(),
    proofRunId: report.runId,
  });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.equal(body.item.proofVerified, true);
  assert.equal(body.proofError, undefined);
  assert.equal(body.item.proof?.verified, true);
  assert.equal(body.item.proof?.runId, report.runId);
  assert.equal(body.item.proof?.shots.length, 2);
  assert.equal(body.item.proof?.artifacts.length, 1);
  assert.equal(body.item.proof?.costUsd, 0.0123);

  // Another account sees the badge and the replay shots.
  const detail = await json(await getDetail(BOB, body.item.id));
  assert.equal(detail.item.proofVerified, true);
  const shotUrl = detail.item.proof.shots[0].url as string;
  const shotRes = await shotGET(
    new Request(`http://localhost${shotUrl}`, { headers: { "x-swarm-user": BOB } }),
    { params: Promise.resolve({ id: body.item.id, index: "0" }) },
  );
  assert.equal(shotRes.status, 200);
  assert.equal(shotRes.headers.get("content-type"), "image/png");
  assert.equal(shotRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(shotRes.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(shotRes.headers.get("content-disposition"), "inline");
  assert.equal(await shotRes.text(), "png-bytes");
});

test("an invalid proof-shot id is a structured error and does not crash", async () => {
  const res = await shotGET(
    new Request("http://localhost/api/library/public/proof/shots/0", {
      headers: { "x-swarm-user": BOB },
    }),
    { params: Promise.resolve({ id: "../etc", index: "0" }) },
  );
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.error, "Invalid id.");
  assert.equal(typeof body.error, "string");
});

test("publish with another account's run, a missing run, or an unfinished run reports proofError and stays unreviewed", async () => {
  const report = fakeReport();
  storeReport(report);
  // Another account's run.
  let res = await publishSkillAs(BOB, {
    kind: "skill",
    name: "Not mine",
    payload: skillPayload(),
    proofRunId: report.runId,
  });
  let body = await json(res);
  assert.equal(res.status, 201);
  assert.equal(body.item.proofVerified, false);
  assert.match(body.proofError, /Only your own runs/);

  // Missing run.
  res = await publishSkillAs(ALICE, {
    kind: "skill",
    name: "No such run",
    payload: skillPayload(),
    proofRunId: "run_missing",
  });
  body = await json(res);
  assert.equal(body.item.proofVerified, false);
  assert.match(body.proofError, /No run report found/);

  // Unfinished run.
  storeReport(fakeReport({ runId: "run_proof_2", status: "error" }));
  res = await publishSkillAs(ALICE, {
    kind: "skill",
    name: "Failed run",
    payload: skillPayload(),
    proofRunId: "run_proof_2",
  });
  body = await json(res);
  assert.equal(body.item.proofVerified, false);
  assert.match(body.proofError, /Only a finished run/);
});

test("a proof does not survive a payload edit: tampering the catalog unverifies it", async () => {
  const report = fakeReport();
  storeReport(report);
  const record = publishItem(ALICE, {
    kind: "skill",
    name: "Deploy helper",
    description: "Ship safely",
    license: "MIT",
    payload: skillPayload(),
  });
  attachProofToCurrentVersion(record, ALICE, report.runId);
  let detail = publicItemDetail(findPublicItem(record.id)!, BOB, false);
  assert.equal(detail.proofVerified, true);
  assert.ok(detail.proof);

  // Edit the stored payload by hand (simulating a tampered catalog).
  const catalogPath = path.join(libDir, "public-library", "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as any;
  catalog.items[0].versions[0].payload.skillMd = "# Deploy (tampered)\n\nRun the checks.";
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

  detail = publicItemDetail(findPublicItem(record.id)!, BOB, false);
  assert.equal(detail.proofVerified, false);
  assert.equal(detail.proof, undefined);

  // The shots route now refuses to serve the stale bundle's images.
  const shotRes = await shotGET(
    new Request("http://localhost/api/library/public/x/proof/shots/0", {
      headers: { "x-swarm-user": BOB },
    }),
    { params: Promise.resolve({ id: record.id, index: "0" }) },
  );
  assert.equal(shotRes.status, 404);
});

test("a proof is bound to its version: a new version without proof is unverified", async () => {
  const report = fakeReport();
  storeReport(report);
  const record = publishItem(ALICE, {
    kind: "skill",
    name: "Deploy helper",
    description: "Ship safely",
    license: "MIT",
    payload: skillPayload(),
  });
  attachProofToCurrentVersion(record, ALICE, report.runId);
  assert.equal(publicItemDetail(findPublicItem(record.id)!, BOB, false).proofVerified, true);

  // Publish v2 (no proof) via the versions store function.
  publishVersion(record.id, ALICE, {
    kind: "skill",
    name: "Deploy helper",
    description: "Ship safely",
    license: "MIT",
    payload: skillPayload("# Deploy v2\n\nMore checks."),
  });
  const detail = publicItemDetail(findPublicItem(record.id)!, BOB, false);
  assert.equal(detail.version, 2);
  assert.equal(detail.proofVerified, false);
  assert.equal(detail.proof, undefined);
});
