import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adminReadinessReport,
  MIN_FREE_DISK_MB,
  publicReadinessReport,
  readinessDetail,
  readinessSnapshot,
} from "./readiness";

let tempDir: string;

// Root bypasses filesystem permission bits, so a chmod-based read-only
// directory cannot enforce a non-writable HOME when running as root. Tests
// that depend on that condition skip with a stated reason under root.
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-readiness-"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** No "/" path strings and no raw error/diagnostic text in a public payload. */
function assertNoOperatorDetail(body: unknown): void {
  const json = JSON.stringify(body);
  assert.equal(json.includes("/"), false, `public payload leaked a path: ${json}`);
  for (const raw of ["ENOENT", "EACCES", "statfs", "docker.sock", "exited", "daemon", "only "]) {
    assert.equal(json.includes(raw), false, `public payload leaked raw detail "${raw}": ${json}`);
  }
  assert.equal(json.includes("detail"), false, `public payload leaked detail object: ${json}`);
}

test("fake driver + writable SWARM_HOME reports ready", async () => {
  const report = await readinessSnapshot({
    SWARM_VM_DRIVER: "fake",
    SWARM_HOME: tempDir,
  });
  assert.equal(report.ready, true);
  assert.equal(report.vmDriver.kind, "fake");
  assert.equal(report.vmDriver.ok, true);
  assert.equal(report.home.ok, true);
  assert.equal(report.home.dir, tempDir);
  assert.equal(report.disk.ok, true);
  assert.equal(typeof report.disk.freeMb, "number");

  const publicReport = publicReadinessReport(report);
  assert.equal(publicReport.ready, true);
  assert.equal(publicReport.home.writable, true);
  assert.equal("dir" in publicReport.home, false);
  assert.equal("freeMb" in publicReport.disk, false);
  assertNoOperatorDetail(publicReport);
});

test("docker driver uses the docker version probe", async () => {
  let called = false;
  const report = await readinessSnapshot(
    { SWARM_VM_DRIVER: "docker", SWARM_HOME: tempDir },
    { dockerChecker: async () => {
      called = true;
      return { ok: true };
    } }
  );
  assert.equal(called, true);
  assert.equal(report.vmDriver.kind, "docker");
  assert.equal(report.vmDriver.ok, true);
  assert.equal(report.ready, true);
});

test("docker probe failure makes readiness fail with a stable reason", async () => {
  const report = await readinessSnapshot(
    { SWARM_VM_DRIVER: "docker", SWARM_HOME: tempDir },
    { dockerChecker: async () => ({ ok: false, message: "docker daemon down" }) }
  );
  assert.equal(report.vmDriver.ok, false);
  assert.equal(report.ready, false);

  const publicReport = publicReadinessReport(report);
  assert.deepEqual(publicReport.vmDriver, { ok: false, reason: "DOCKER_UNREACHABLE" });
  assertNoOperatorDetail(publicReport);
});

test("raw docker errors never reach the public payload", async () => {
  const report = await readinessSnapshot(
    { SWARM_VM_DRIVER: "docker", SWARM_HOME: tempDir },
    { dockerChecker: async () => ({ ok: false, message: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }) }
  );
  const publicReport = publicReadinessReport(report);
  assert.equal(JSON.stringify(publicReport).includes("docker.sock"), false);
  assert.equal(JSON.stringify(publicReport).includes("/var/run"), false);
});

test("SWARM_HOME pointing at a file is not writable", async () => {
  const file = join(tempDir, "not-a-dir");
  writeFileSync(file, "x");
  const report = await readinessSnapshot({ SWARM_HOME: file });
  assert.equal(report.home.ok, false);
  assert.equal(report.home.reason, "HOME_NOT_WRITABLE");
  assert.equal(report.ready, false);

  const publicReport = publicReadinessReport(report);
  assert.deepEqual(publicReport.home, { ok: false, writable: false, reason: "HOME_NOT_WRITABLE" });
  assertNoOperatorDetail(publicReport);
});

test("a read-only home directory reports HOME_NOT_WRITABLE", { skip: IS_ROOT ? "root bypasses fs permission bits; a read-only HOME cannot be constructed as root" : false }, async () => {
  const dir = join(tempDir, "read-only");
  mkdirSync(dir, { mode: 0o500 });
  chmodSync(dir, 0o500);
  const report = await readinessSnapshot({ SWARM_HOME: dir });
  assert.equal(report.home.ok, false);
  assert.equal(report.home.reason, "HOME_NOT_WRITABLE");

  const publicReport = publicReadinessReport(report);
  assert.equal(publicReport.home.reason, "HOME_NOT_WRITABLE");
  assertNoOperatorDetail(publicReport);
});

test("a missing home that cannot be created reports HOME_MISSING", { skip: IS_ROOT ? "root bypasses fs permission bits; an uncreatable HOME cannot be constructed as root" : false }, async () => {
  const readOnlyParent = join(tempDir, "read-only-parent");
  mkdirSync(readOnlyParent, { mode: 0o500 });
  chmodSync(readOnlyParent, 0o500);
  const home = join(readOnlyParent, "missing-home");

  const report = await readinessSnapshot({ SWARM_HOME: home });
  assert.equal(report.home.ok, false);
  assert.equal(report.home.reason, "HOME_MISSING");
  assert.equal(report.ready, false);

  const publicReport = publicReadinessReport(report);
  assert.deepEqual(publicReport.home, { ok: false, writable: false, reason: "HOME_MISSING" });
  assertNoOperatorDetail(publicReport);
});

test("low free disk fails readiness with DISK_LOW and no byte counts publicly", async () => {
  const report = await readinessSnapshot(
    { SWARM_HOME: tempDir },
    {
      statfsSync: () => ({ bavail: 8, bsize: 512 }),
    }
  );
  assert.equal(report.disk.ok, false);
  assert.equal(report.disk.freeMb < MIN_FREE_DISK_MB, true);
  assert.equal(report.ready, false);

  const publicReport = publicReadinessReport(report);
  assert.deepEqual(publicReport.disk, { ok: false, low: true, reason: "DISK_LOW" });
  assert.equal(JSON.stringify(publicReport).includes(String(report.disk.freeBytes)), false);
  assertNoOperatorDetail(publicReport);
});

test("disk stat errors map to DISK_UNAVAILABLE without raw error text", async () => {
  const report = await readinessSnapshot(
    { SWARM_HOME: tempDir },
    {
      statfsSync: () => {
        throw new Error("statfs /home/secret/.swarmagents failed: ENOENT");
      },
    }
  );
  assert.equal(report.disk.ok, false);
  assert.equal(report.disk.reason, "DISK_UNAVAILABLE");
  assert.equal(report.ready, false);

  const publicReport = publicReadinessReport(report);
  assert.deepEqual(publicReport.disk, { ok: false, low: false, reason: "DISK_UNAVAILABLE" });
  assertNoOperatorDetail(publicReport);
});

test("admin report retains path, byte counts and fixed diagnostics", async () => {
  const report = await readinessSnapshot(
    { SWARM_VM_DRIVER: "docker", SWARM_HOME: join(tempDir, "missing") },
    { dockerChecker: async () => ({ ok: false, message: "docker unreachable" }) }
  );
  const admin = adminReadinessReport(report);
  assert.equal(admin.detail.home.dir, join(tempDir, "missing"));
  assert.equal(typeof admin.detail.disk.freeBytes, "number");
  assert.equal(typeof admin.detail.disk.freeMb, "number");
  assert.equal(admin.detail.vmDriver.kind, "docker");
  assert.equal(admin.detail.vmDriver.message, "docker unreachable");
  // Diagnostics are fixed strings, never the raw thrown error.
  assert.equal(JSON.stringify(admin.detail).includes("ENOENT"), false);
});

test("readinessDetail exposes operator detail separately from the public payload", async () => {
  const report = await readinessSnapshot({ SWARM_HOME: tempDir });
  const detail = readinessDetail(report);
  assert.equal(detail.home.dir, tempDir);

  const publicReport = publicReadinessReport(report);
  assert.equal("dir" in publicReport.home, false);
  assert.equal("freeBytes" in publicReport.disk, false);
});
