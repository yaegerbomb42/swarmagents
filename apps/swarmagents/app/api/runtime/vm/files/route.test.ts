/**
 * End-to-end tests for /api/runtime/vm/files using the fake VM driver.
 *
 * The route -> VmManager -> FakeVmDriver path is exercised without Docker.
 * Auth is the middleware-set x-swarm-user header.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { VmManager, setVmManagerForTesting } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";
import { MAX_FILE_DOWNLOAD_BYTES, MAX_FILE_READ_BYTES } from "../../../../../lib/vm/files";

function request(path: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, { headers });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

/** Install a fake-backed VM manager and return it for file seeding. */
function install(): VmManager {
  const manager = new VmManager({ customDriver: new FakeVmDriver() });
  setVmManagerForTesting(manager);
  return manager;
}

/** Install a manager whose fake driver models symlinks. */
function installWithLinks(): { vm: VmManager; driver: FakeVmDriver } {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);
  return { vm: manager, driver };
}

test.afterEach(() => {
  setVmManagerForTesting(null);
});

test("rejects unauthenticated requests", async () => {
  install();
  const res = await GET(request("/api/runtime/vm/files?path=/workspace", null));
  assert.equal(res.status, 401);
});

test("lists the workspace directory", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/hello.txt", "hello");
  await vm.writeFile("alice", "/workspace/src/app.ts", "export const x = 1;\n");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.kind, "directory");
  assert.equal(body.path, "/workspace");
  assert.equal(body.root, "/workspace");
  assert.equal(body.parent, null);

  const names = body.entries.map((e: any) => e.name);
  assert.deepEqual(names, ["src", "hello.txt"]);

  const src = body.entries.find((e: any) => e.name === "src");
  assert.equal(src.type, "directory");
  assert.equal(src.path, "/workspace/src");

  const hello = body.entries.find((e: any) => e.name === "hello.txt");
  assert.equal(hello.type, "file");
  assert.equal(hello.size, 5);
});

test("lists a nested directory and reports its parent", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/src/app.ts", "code");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/src"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.path, "/workspace/src");
  assert.equal(body.parent, "/workspace");
  assert.deepEqual(body.entries.map((e: any) => e.path), ["/workspace/src/app.ts"]);
});

test("defaults to the workspace root when no path is given", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/notes.md", "# hi");

  const res = await GET(request("/api/runtime/vm/files"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.path, "/workspace");
  assert.deepEqual(body.entries.map((e: any) => e.name), ["notes.md"]);
});

test("reads file content with ?read=1", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/hello.txt", "hello world");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/hello.txt&read=1"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.kind, "file");
  assert.equal(body.path, "/workspace/hello.txt");
  assert.equal(body.content, "hello world");
  assert.equal(body.binary, false);
  assert.equal(body.truncated, false);
  assert.equal(body.size, 11);
  assert.equal(body.limit, MAX_FILE_READ_BYTES);
});

test("a relative path is resolved inside the workspace", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/readme.md", "read me");

  const res = await GET(request("/api/runtime/vm/files?path=readme.md&read=1"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.path, "/workspace/readme.md");
  assert.equal(body.content, "read me");
});

test("rejects path traversal", async () => {
  install();
  for (const bad of ["../etc/passwd", "/workspace/../etc/passwd", "/workspace/../../etc/passwd", ".."]) {
    const res = await GET(request(`/api/runtime/vm/files?path=${encodeURIComponent(bad)}`));
    assert.equal(res.status, 403, `expected ${bad} to be rejected`);
    const body = await json(res);
    assert.equal(body.code, "outside_workspace");
  }
});

test("rejects paths outside the workspace", async () => {
  install();
  const res = await GET(request("/api/runtime/vm/files?path=%2Fetc%2Fpasswd&read=1"));
  assert.equal(res.status, 403);
  const body = await json(res);
  assert.equal(body.code, "outside_workspace");
});

test("rejects a malformed path", async () => {
  install();
  const res = await GET(request("/api/runtime/vm/files?path=%2Fworkspace%2Fa%00b"));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, "invalid_path");
});

test("reading a missing file is a 404", async () => {
  install();
  const res = await GET(request("/api/runtime/vm/files?path=/workspace/ghost.txt&read=1"));
  assert.equal(res.status, 404);
  const body = await json(res);
  assert.equal(body.code, "not_found");
});

test("reading a directory as a file is rejected", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/src/app.ts", "code");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/src&read=1"));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, "is_a_directory");
});

test("listing a file as a directory is rejected", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/hello.txt", "hello");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/hello.txt"));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, "not_a_directory");
});

test("binary files are detected and not returned as text", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/image.bin", "PNG\u0000\u0001\u0002binary");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/image.bin&read=1"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.binary, true);
  assert.equal(body.content, undefined);
  assert.equal(body.size, 12);
});

test("file reads are capped at 1 MB", async () => {
  const vm = install();
  const big = "x".repeat(MAX_FILE_READ_BYTES + 4096);
  await vm.writeFile("alice", "/workspace/big.txt", big);

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/big.txt&read=1"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.truncated, true);
  assert.equal(body.size, big.length);
  assert.equal(body.content.length, MAX_FILE_READ_BYTES);
});

test("users only see their own VM", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/alice-secret.txt", "alice only");
  await vm.writeFile("bob", "/workspace/bob-secret.txt", "bob only");

  const alice = await json(await GET(request("/api/runtime/vm/files?path=/workspace", "alice")));
  assert.deepEqual(alice.entries.map((e: any) => e.name), ["alice-secret.txt"]);

  const bob = await json(await GET(request("/api/runtime/vm/files?path=/workspace", "bob")));
  assert.deepEqual(bob.entries.map((e: any) => e.name), ["bob-secret.txt"]);

  const cross = await GET(request("/api/runtime/vm/files?path=/workspace/alice-secret.txt&read=1", "bob"));
  assert.equal(cross.status, 404);
});

test("downloads raw bytes for a text file with attachment headers", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/hello.txt", "hello world");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/hello.txt&download=1"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="hello\.txt"/);
  assert.equal(res.headers.get("content-length"), "11");
  assert.equal(await res.text(), "hello world");
});

test("downloads raw bytes for a binary file", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/image.png", "PNG\u0000\u0001\u0002binary");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/image.png&download=1"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("content-disposition") ?? "", /filename="image\.png"/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(
    Array.from(bytes),
    Array.from(Buffer.from("PNG\u0000\u0001\u0002binary", "utf8")),
  );
});

test("download rejects unauthenticated requests", async () => {
  install();
  const res = await GET(request("/api/runtime/vm/files?path=/workspace/hello.txt&download=1", null));
  assert.equal(res.status, 401);
});

test("download rejects path traversal", async () => {
  install();
  for (const bad of ["../etc/passwd", "/workspace/../etc/passwd", "/workspace/../../etc/passwd"]) {
    const res = await GET(
      request(`/api/runtime/vm/files?path=${encodeURIComponent(bad)}&download=1`),
    );
    assert.equal(res.status, 403, `expected ${bad} to be rejected`);
    const body = await json(res);
    assert.equal(body.code, "outside_workspace");
  }
});

test("download of a directory is rejected", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/src/app.ts", "code");

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/src&download=1"));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, "is_a_directory");
});

test("download of an oversized file is refused with 413, never truncated", async () => {
  const vm = install();
  const big = "x".repeat(MAX_FILE_DOWNLOAD_BYTES + 1);
  await vm.writeFile("alice", "/workspace/huge.bin", big);

  const res = await GET(request("/api/runtime/vm/files?path=/workspace/huge.bin&download=1"));
  assert.equal(res.status, 413);
  const body = await json(res);
  assert.equal(body.code, "file_too_large");
  assert.equal(body.size, big.length);
  assert.equal(body.limit, MAX_FILE_DOWNLOAD_BYTES);
});

test("read and download refuse a workspace symlink that points outside /workspace", async () => {
  const { driver } = installWithLinks();
  const handle = await driver.ensure("alice");
  await driver.writeFile(handle, "/workspace/notes.txt", "safe");
  await driver.writeFile(handle, "/etc/passwd", "root:x:0:0:root:/root:/bin/bash");
  driver.symlink("alice", "/workspace/passwd-link", "/etc/passwd");
  driver.symlink("alice", "/workspace/etc-link", "/etc");

  for (const query of ["read=1", "download=1"]) {
    const file = await GET(request(`/api/runtime/vm/files?path=%2Fworkspace%2Fpasswd-link&${query}`));
    assert.equal(file.status, 403, `expected the file symlink to be refused for ${query}`);
    assert.equal((await json(file)).code, "outside_workspace");

    const dir = await GET(request(`/api/runtime/vm/files?path=%2Fworkspace%2Fetc-link&${query}`));
    assert.equal(dir.status, 403, `expected the directory symlink to be refused for ${query}`);
    assert.equal((await json(dir)).code, "outside_workspace");
  }

  // Ordinary workspace files keep working.
  const ok = await GET(request("/api/runtime/vm/files?path=%2Fworkspace%2Fnotes.txt&read=1"));
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).content, "safe");
});

test("listing refuses a directory symlink that points outside /workspace", async () => {
  const { driver } = installWithLinks();
  const handle = await driver.ensure("alice");
  await driver.writeFile(handle, "/workspace/src/app.ts", "code");
  driver.symlink("alice", "/workspace/out", "/etc");

  const res = await GET(request("/api/runtime/vm/files?path=%2Fworkspace%2Fout"));
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, "outside_workspace");
});

test("a symlink that stays inside /workspace is still readable", async () => {
  const { driver } = installWithLinks();
  const handle = await driver.ensure("alice");
  await driver.writeFile(handle, "/workspace/real.txt", "real content");
  driver.symlink("alice", "/workspace/alias.txt", "/workspace/real.txt");

  const res = await GET(request("/api/runtime/vm/files?path=%2Fworkspace%2Falias.txt&read=1"));
  assert.equal(res.status, 200);
  assert.equal((await json(res)).content, "real content");
});

// ---------------------------------------------------------------------------
// recent=1: the workspace's recently-touched files
// ---------------------------------------------------------------------------

/** Push a file's fake mtime back so it falls outside a fresh window. */
function ageFile(driver: FakeVmDriver, user: string, path: string, ageMs: number): void {
  const vms = (driver as unknown as { vms: Map<string, { mtimes: Map<string, number> }> }).vms;
  const vm = vms.get(user);
  assert.ok(vm, `fake vm for ${user} exists`);
  vm.mtimes.set(path, Date.now() - ageMs);
}

test("recent=1 lists files across nested directories, most recent first", async () => {
  const vm = install();
  const driver = vm.driver as FakeVmDriver;
  await vm.writeFile("alice", "/workspace/notes.md", "# hi");
  await vm.writeFile("alice", "/workspace/src/app.ts", "export const x = 1;\n");
  await vm.writeFile("alice", "/workspace/src/lib/deep.json", "{}");
  ageFile(driver, "alice", "/workspace/notes.md", 30_000);
  ageFile(driver, "alice", "/workspace/src/app.ts", 20_000);
  ageFile(driver, "alice", "/workspace/src/lib/deep.json", 1_000);

  const res = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.kind, "recent");
  assert.equal(body.path, "/workspace");
  assert.deepEqual(body.files.map((f: any) => f.path), [
    "/workspace/src/lib/deep.json",
    "/workspace/src/app.ts",
    "/workspace/notes.md",
  ]);
  const first = body.files[0];
  assert.equal(first.name, "deep.json");
  assert.equal(first.size, 2);
  assert.equal(typeof first.modifiedAt, "number");
  assert.equal(first.contentType, "application/json");
});

test("recent=1 excludes files older than the window", async () => {
  const vm = install();
  const driver = vm.driver as FakeVmDriver;
  await vm.writeFile("alice", "/workspace/fresh.txt", "new");
  await vm.writeFile("alice", "/workspace/stale.txt", "old");
  ageFile(driver, "alice", "/workspace/stale.txt", 30 * 60_000);

  const res = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.files.map((f: any) => f.path), ["/workspace/fresh.txt"]);
});

test("recent=1 clamps windowMs and limit", async () => {
  const vm = install();
  const driver = vm.driver as FakeVmDriver;
  await vm.writeFile("alice", "/workspace/a.txt", "a");
  await vm.writeFile("alice", "/workspace/b.txt", "b");
  ageFile(driver, "alice", "/workspace/a.txt", 10_000);

  const capped = await GET(
    request("/api/runtime/vm/files?path=/workspace&recent=1&windowMs=999999999&limit=1"),
  );
  assert.equal(capped.status, 200);
  const cappedBody = await json(capped);
  assert.equal(cappedBody.windowMs, 60 * 60_000);
  assert.deepEqual(cappedBody.files.map((f: any) => f.path), ["/workspace/b.txt"]);

  const defaulted = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1"));
  assert.equal((await json(defaulted)).windowMs, 15 * 60_000);

  const floor = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1&limit=0"));
  assert.equal((await json(floor)).files.length, 1);
});

test("recent=1 rejects unauthenticated requests and bad paths", async () => {
  // Live VM: a missing directory is only knowable (404) when the VM runs; a
  // stopped VM answers "no recent files" without being woken (test below).
  await install().ensure("alice");
  const unauth = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1", null));
  assert.equal(unauth.status, 401);

  const missing = await GET(request("/api/runtime/vm/files?path=/workspace/nope&recent=1"));
  assert.equal(missing.status, 404);

  const traversal = await GET(
    request(`/api/runtime/vm/files?path=${encodeURIComponent("/workspace/../etc")}&recent=1`),
  );
  assert.equal(traversal.status, 403);
});

test("recent=1 on a file path is a 400; users only see their own VM", async () => {
  const vm = install();
  await vm.writeFile("alice", "/workspace/a.txt", "a");
  await vm.writeFile("bob", "/workspace/b.txt", "b");

  const fileRes = await GET(request("/api/runtime/vm/files?path=/workspace/a.txt&recent=1"));
  assert.equal(fileRes.status, 400);

  const bobRes = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1", "bob"));
  assert.equal(bobRes.status, 200);
  const bobBody = await json(bobRes);
  assert.deepEqual(bobBody.files.map((f: any) => f.path), ["/workspace/b.txt"]);
});

// recent=1 fast path (review follow-up for #321): one in-VM find per poll,
// no per-directory listDir walk, and a poll never resurrects a stopped VM.
class FindDriver extends FakeVmDriver {
  listDirCalls = 0;
  findCalls = 0;
  override async listDir(...args: Parameters<FakeVmDriver["listDir"]>) {
    this.listDirCalls += 1;
    return super.listDir(...args);
  }
  override async exec(...args: Parameters<FakeVmDriver["exec"]>) {
    const [handle, cmd, opts] = args;
    if (cmd[0] === "find") {
      this.findCalls += 1;
      const t = (Date.now() - 2_000) / 1000;
      opts?.onStdout?.(`${t.toFixed(6)}\t5\t/workspace/report.csv\n${t.toFixed(6)}\t9\t/workspace/src/app.ts\n`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

test("recent=1 uses ONE find exec and no listDir walk", async () => {
  const driver = new FindDriver();
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);
  await manager.ensure("alice");
  const res = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.files.map((f: any) => f.path).sort(), ["/workspace/report.csv", "/workspace/src/app.ts"]);
  assert.equal(driver.findCalls, 1);
  assert.equal(driver.listDirCalls, 0, "the per-directory walk is not used when find works");
});

test("recent=1 on a stopped VM returns no files and does not wake it", async () => {
  const driver = new FindDriver();
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);
  await manager.ensure("alice");
  await manager.stop("alice");
  const res = await GET(request("/api/runtime/vm/files?path=/workspace&recent=1"));
  assert.equal(res.status, 200);
  assert.deepEqual((await json(res)).files, []);
  assert.equal(driver.findCalls, 0);
  assert.equal(driver.listDirCalls, 0);
  const status = await manager.status("alice");
  assert.notEqual(status, "running", "a recent-files poll must not resurrect the VM");
});
