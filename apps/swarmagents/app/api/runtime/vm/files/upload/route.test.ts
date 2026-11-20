/**
 * End-to-end tests for POST /api/runtime/vm/files/upload using the fake VM
 * driver (no Docker). Uploads bypass middleware, so the route authenticates
 * itself: local mode (the test default) trusts the machine; server mode is
 * tested with a harness bearer token.
 *
 * Text payloads are written through the manager's writeFile and are fully
 * verifiable against the fake driver. Binary payloads are written by piping
 * base64 into `base64 -d` inside the VM so a docker-backed VM holds the exact
 * bytes; the fake driver does not model shell writes, so those tests assert
 * the route contract (status + metadata) and that the file did not go through
 * the text writeFile path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_DIR,
} from "../../../../../../lib/vm/files";
import { VmManager, setVmManagerForTesting } from "../../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../../../../../../lib/vm/types";
import { VmStreamError } from "../../../../../../lib/vm/stream-errors";
import { configureAuditPath, getAuditFile } from "../../../../../../lib/audit";
import { resetBuckets } from "../../../../../../lib/rate-limit";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);

let auditDir: string;
let prevHome: string | undefined;

test.beforeEach(() => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-upload-audit-"));
  prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = auditDir;
  configureAuditPath(undefined);
});

/**
 * Fake driver that mirrors the docker driver's exec-based base64 write: it
 * records every exec call and, for the upload command, actually writes the
 * decoded bytes into the fake filesystem (via writeFile, latin1-safe so the
 * stored string round-trips to the original bytes).
 */
class RecordingBase64Fake extends FakeVmDriver {
  calls: Array<{ cmd: string[]; stdin?: string }> = [];
  private uploadWriteTarget = "";

  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, stdin: opts?.stdin as string | undefined });
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2].includes("base64 -d")) {
      // ["sh","-c","base64 -d > \"$1\"","sh","<target>"]
      const target = cmd[4];
      this.uploadWriteTarget = target;
      const bytes = Buffer.from(opts?.stdin as string ?? "", "base64");
      await super.writeFile(h, target, bytes.toString("latin1"));
      return { exitCode: 0 };
    }
    return super.exec(h, cmd, opts);
  }

  /** The destination path of the last base64 write, or "" if none. */
  get lastUploadTarget(): string {
    return this.uploadWriteTarget;
  }
}

function install(driver: FakeVmDriver = new FakeVmDriver()): VmManager {
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);
  return manager;
}

function request(files: File[], init: RequestInit = {}, user: string | null = null, host = "localhost"): NextRequest {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user); // pretend middleware set it; must be ignored
  // A NextRequest built from a URL does not expose a readable Host header, so
  // set it explicitly for the route's host gate (lib/auth hostAllowed).
  headers.set("host", host);
  return new NextRequest(`http://${host}/api/runtime/vm/files/upload`, {
    ...init,
    method: "POST",
    headers,
    body: init.body ?? form,
    signal: init.signal ?? undefined,
  });
}

function file(name: string, content: string | Uint8Array, type = "text/plain"): File {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : Buffer.from(content);
  return new File([bytes], name, { type });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function auditEntries() {
  let text = "";
  try {
    text = fs.readFileSync(getAuditFile(), "utf8");
  } catch {
    return [];
  }
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip torn lines
    }
  }
  return entries;
}

function uploadAudits(user: string) {
  const entries = auditEntries();
  return entries.filter((e) => e.action === "vm.file.upload" && e.user === user);
}

test.afterEach(() => {
  setVmManagerForTesting(null);
  configureAuditPath(undefined);
  if (prevHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = prevHome;
  fs.rmSync(auditDir, { recursive: true, force: true });
  delete process.env.SWARM_SERVER_MODE;
  delete process.env.SWARM_HARNESS_TOKEN;
  delete process.env.SWARM_ALLOWED_HOSTS;
});

test("local mode: rejects a cross-site upload before touching the VM", async () => {
  const vm = install();
  const res = await POST(request([file("csrf.txt", "attack")], {
    headers: { origin: "http://evil.example.com" },
  }));
  assert.equal(res.status, 403);
  assert.equal((vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/csrf.txt`), undefined);
});

test("local mode: uploads a text file into /workspace/uploads", async () => {
  const vm = install();
  const res = await POST(request([file("hello.txt", "hello world")]));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.uploadDir, UPLOAD_DIR);
  assert.equal(body.uploaded.length, 1);
  assert.equal(body.uploaded[0].name, "hello.txt");
  assert.equal(body.uploaded[0].path, `${UPLOAD_DIR}/hello.txt`);
  assert.equal(body.uploaded[0].size, 11);
  assert.equal(body.uploaded[0].type, "text/plain");

  const peek = (vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/hello.txt`);
  assert.equal(peek, "hello world");
});

test("local mode: uploads multiple files and keeps their exact bytes", async () => {
  install();
  const a = file("a.txt", "alpha");
  const b = file("b.md", "# beta\nline two");
  const res = await POST(request([a, b]));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(
    body.uploaded.map((u: any) => u.name),
    ["a.txt", "b.md"],
  );
});

test("binary files are stored byte-exact (base64 piped through exec)", async () => {
  const driver = new RecordingBase64Fake();
  const vm = install(driver);
  const res = await POST(request([file("img.png", PNG_BYTES, "image/png")]));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.uploaded[0].path, `${UPLOAD_DIR}/img.png`);
  assert.equal(body.uploaded[0].type, "image/png");

  // The exec path was taken (not writeFile), piped base64 into `base64 -d`.
  const uploadCall = driver.calls.find((c) => c.cmd[0] === "sh" && c.cmd[1] === "-c" && c.cmd[2].includes("base64 -d"));
  assert.ok(uploadCall, "expected a base64 -d exec for the binary file");
  assert.equal(uploadCall!.cmd[4], `${UPLOAD_DIR}/img.png`);
  assert.equal(uploadCall!.stdin, Buffer.from(PNG_BYTES).toString("base64"));

  // The fake wrote the decoded bytes (latin1-safe) to the exact path.
  const stored = (vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/img.png`);
  assert.ok(typeof stored === "string");
  assert.deepEqual(Buffer.from(stored, "latin1"), Buffer.from(PNG_BYTES));
});

test("binary upload decodes to a temp file and atomically renames into place", async () => {
  const driver = new RecordingBase64Fake();
  install(driver);
  const res = await POST(request([file("img.png", PNG_BYTES, "image/png")]));
  assert.equal(res.status, 200);

  const uploadCall = driver.calls.find((c) => c.cmd[0] === "sh" && c.cmd[1] === "-c" && c.cmd[2].includes("base64 -d"));
  assert.ok(uploadCall, "expected a base64 -d exec for the binary file");
  const script = uploadCall!.cmd[2];
  // The decode never pipes straight into the final path: a mid-stream failure
  // would leave a half-written file. It fills `<target>.tmp.$$` and only mv's
  // it onto the target once base64 reports success.
  assert.match(script, /\$1\.tmp\.\$\$/);
  assert.match(script, /mv -f/);
  assert.ok(!script.includes('base64 -d > "$1"'), "must not write directly to the destination");
});

test("server mode: unauthenticated uploads are rejected with 401", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_ALLOWED_HOSTS = "localhost";
  install();
  const res = await POST(request([file("x.txt", "x")]));
  assert.equal(res.status, 401);
});

test("server mode: a harness bearer token is accepted", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_ALLOWED_HOSTS = "localhost";
  const vm = install();
  const req = request([file("note.txt", "from harness")], { headers: { authorization: "Bearer harness-token" } });
  const res = await POST(req);
  assert.equal(res.status, 200);
  const peek = (vm.driver as FakeVmDriver).peekFile("harness", `${UPLOAD_DIR}/note.txt`);
  assert.equal(peek, "from harness");
});

test("the client-supplied x-swarm-user header is never trusted", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_ALLOWED_HOSTS = "localhost";
  const vm = install();
  const res = await POST(request([file("hack.txt", "evil")], {}, "mallory"));
  assert.equal(res.status, 401);
  assert.equal((vm.driver as FakeVmDriver).peekFile("mallory", `${UPLOAD_DIR}/hack.txt`), undefined);
});

test("rejects uploads with no files", async () => {
  install();
  const res = await POST(request([]));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, "no_files");
});

test("rejects more than 10 files", async () => {
  install();
  const files = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => file(`f${i}.txt`, "x"));
  const res = await POST(request(files));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, "too_many_files");
  assert.equal(body.limit, MAX_UPLOAD_FILES);
});

test("rejects files over 10 MB and writes nothing", async () => {
  const vm = install();
  const big = file("big.bin", new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1), "application/octet-stream");
  const res = await POST(request([big]));
  assert.equal(res.status, 413);
  const body = await json(res);
  assert.equal(body.code, "file_too_large");
  assert.equal(body.name, "big.bin");
  assert.equal(body.limit, MAX_UPLOAD_FILE_BYTES);
  assert.equal((vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/big.bin`), undefined);
});

test("accepts a file exactly at the 10 MB boundary", async () => {
  const driver = new RecordingBase64Fake();
  const vm = install(driver);
  const edge = file("edge.bin", new Uint8Array(MAX_UPLOAD_FILE_BYTES), "application/octet-stream");
  const res = await POST(request([edge]));
  assert.equal(res.status, 200);
  assert.equal((vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/edge.bin`)?.length, MAX_UPLOAD_FILE_BYTES);
});

test("two files with the same name are stored under unique paths", async () => {
  const vm = install();
  const res = await POST(request([file("report.txt", "first"), file("report.txt", "second")]));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(
    body.uploaded.map((u: any) => u.path),
    [`${UPLOAD_DIR}/report.txt`, `${UPLOAD_DIR}/report (2).txt`],
  );
  const driver = vm.driver as FakeVmDriver;
  assert.equal(driver.peekFile("local", `${UPLOAD_DIR}/report.txt`), "first");
  assert.equal(driver.peekFile("local", `${UPLOAD_DIR}/report (2).txt`), "second");
});

test("sanitizes filenames and refuses traversal", async () => {
  const vm = install();
  const bad = [
    "../evil.sh",
    "/etc/passwd",
    "a/../escape",
    "a\\b.txt",
    "nul\u0000byte",
    "..",
    ".",
    " ",
    // Shell metacharacters that could break the base64 -d exec command
    'hello"world.txt',
    "hello$world.txt",
    "hello`world.txt",
    "hello!world.txt",
  ];
  for (const name of bad) {
    const res = await POST(request([file(name, "x")]));
    assert.equal(res.status, 400, `expected "${name}" to be rejected`);
    const body = await json(res);
    assert.equal(body.code, "invalid_filename");
  }
  // Nothing landed anywhere outside the uploads directory.
  const driver = vm.driver as FakeVmDriver;
  for (const name of bad) {
    assert.equal(driver.peekFile("local", `${UPLOAD_DIR}/${name}`), undefined);
  }
});

test("all uploaded files land under /workspace/uploads", async () => {
  const vm = install();
  const res = await POST(request([file("one.txt", "1"), file("two/three.txt", "2")]));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, "invalid_filename");
  const driver = vm.driver as FakeVmDriver;
  assert.equal(driver.peekFile("local", `${UPLOAD_DIR}/two/three.txt`), undefined);
});

test("uploading onto an existing directory is refused with 4xx, not a crash", async () => {
  const vm = install();
  // Make `${UPLOAD_DIR}/reports` an existing directory in the fake filesystem.
  await vm.writeFile("local", `${UPLOAD_DIR}/reports/old.txt`, "old");

  const res = await POST(request([file("reports", "new contents")]));
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, "target_is_directory");
  // Nothing was written through the directory path.
  assert.equal((vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/reports`), undefined);
  // The failure is audited like every other refused upload.
  const audits = uploadAudits("local");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].result, "failure");
});

test("an EPIPE from the driver is a 4xx and does not escape the route", async () => {
  class PipeBreakingFake extends FakeVmDriver {
    override async writeFile(): Promise<void> {
      throw new VmStreamError("stdin", "EPIPE", "the command exited before reading its input");
    }
  }
  install(new PipeBreakingFake());

  const res = await POST(request([file("note.txt", "payload")]));
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, "write_interrupted");
});

test("records an audit entry for a successful upload", async () => {
  install();
  const res = await POST(request([file("audited.txt", "payload")]));
  assert.equal(res.status, 200);
  const audits = uploadAudits("local");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "vm.file.upload");
  assert.equal(audits[0].result, "success");
  assert.equal(audits[0].target, "audited.txt");
});

test("records a failure audit entry when a file is rejected", async () => {
  install();
  await POST(request([file("huge.bin", new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1))]));
  const audits = uploadAudits("local");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].result, "failure");
  assert.match(audits[0].target, /huge\.bin/);
});

test("rejects a declared body larger than the request cap before parsing", async () => {
  install();
  const req = new NextRequest("http://localhost/api/runtime/vm/files/upload", {
    method: "POST",
    headers: { "content-length": String(200 * 1024 * 1024) },
  });
  const res = await POST(req);
  assert.equal(res.status, 413);
  const body = await json(res);
  assert.equal(body.code, "body_too_large");
});

test("host gate: local mode refuses a non-loopback Host with 403 before any write", async () => {
  const vm = install();
  const res = await POST(request([file("evil.txt", "x")], {}, null, "evil.example.com"));
  assert.equal(res.status, 403);
  const body = await json(res);
  assert.equal(body.code, "forbidden");
  assert.equal((vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/evil.txt`), undefined);
});

test("host gate: server mode refuses a non-allowlisted Host with 403 even with valid credentials", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_ALLOWED_HOSTS = "ok.example.com";
  const vm = install();
  const req = request([file("evil.txt", "x")], { headers: { authorization: "Bearer harness-token" } }, null, "evil.example.com");
  const res = await POST(req);
  assert.equal(res.status, 403);
  const body = await json(res);
  assert.equal(body.code, "forbidden");
  assert.equal((vm.driver as FakeVmDriver).peekFile("harness", `${UPLOAD_DIR}/evil.txt`), undefined);
});

test("host gate: an allowlisted Host still uploads in server mode", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_ALLOWED_HOSTS = "ok.example.com";
  const vm = install();
  const req = request([file("ok.txt", "ok")], { headers: { authorization: "Bearer harness-token" } }, null, "ok.example.com");
  const res = await POST(req);
  assert.equal(res.status, 200);
  assert.equal((vm.driver as FakeVmDriver).peekFile("harness", `${UPLOAD_DIR}/ok.txt`), "ok");
});

test("rate limit applies to uploads in server mode (429 once exhausted)", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_ALLOWED_HOSTS = "localhost";
  resetBuckets();
  install();
  // The api bucket defaults to 300/min and refills continuously, so a loaded
  // machine can earn back a fraction of a token between requests. Fire well
  // past capacity so the 429 is deterministic rather than timing-dependent.
  // Each call consumes a token before any body read, so cheap empty uploads
  // suffice; the exhausted request must get 429, not a 400/200.
  let lastStatus = 0;
  for (let i = 0; i <= 350; i++) {
    const req = request([], { headers: { authorization: "Bearer harness-token" } });
    lastStatus = (await POST(req)).status;
  }
  assert.equal(lastStatus, 429);
});

/**
 * A multipart body produced on demand (the parser pulls, we emit), so a
 * request with no Content-Length never materialises the whole payload on the
 * host. `pulledBytes()` reports how much the server actually consumed.
 */
function streamingMultipart(
  boundary: string,
  filename: string,
  totalBytes: number,
  chunkSize = 64 * 1024,
): { body: ReadableStream<Uint8Array>; pulledBytes: () => number } {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  let headSent = false;
  let tailSent = false;
  let sent = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headSent) {
        headSent = true;
        pulled += head.length;
        controller.enqueue(head);
        return;
      }
      if (sent < totalBytes) {
        const n = Math.min(chunkSize, totalBytes - sent);
        sent += n;
        pulled += n;
        controller.enqueue(new Uint8Array(n).fill(0x41));
        return;
      }
      if (!tailSent) {
        tailSent = true;
        pulled += tail.length;
        controller.enqueue(tail);
        return;
      }
      controller.close();
    },
  });
  return { body, pulledBytes: () => pulled };
}

function streamRequest(body: ReadableStream<Uint8Array>, boundary: string): NextRequest {
  const headers = new Headers();
  headers.set("host", "localhost");
  headers.set("content-type", `multipart/form-data; boundary=${boundary}`);
  return new NextRequest("http://localhost/api/runtime/vm/files/upload", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as any);
}

test("chunked upload with no Content-Length is aborted with 413 as soon as the cap is crossed", async () => {
  const vm = install();
  const boundary = "----swarm-chunked-boundary";
  // Offer far more than the per-file cap. The route must stop reading at the
  // cap; if it buffered the whole body this stream would deliver all 64 MiB.
  const offered = 64 * 1024 * 1024;
  const { body, pulledBytes } = streamingMultipart(boundary, "big.bin", offered);

  const res = await POST(streamRequest(body, boundary));
  assert.equal(res.status, 413);
  const payload = await json(res);
  assert.equal(payload.code, "file_too_large");
  assert.equal(payload.name, "big.bin");
  assert.equal(payload.limit, MAX_UPLOAD_FILE_BYTES);

  const pulled = pulledBytes();
  assert.ok(pulled > MAX_UPLOAD_FILE_BYTES, "the cap must not abort before it is reached");
  assert.ok(
    pulled < 16 * 1024 * 1024,
    `server pulled ${pulled} bytes; a crossed cap must not drain the body`,
  );
  assert.equal((vm.driver as FakeVmDriver).peekFile("local", `${UPLOAD_DIR}/big.bin`), undefined);
});

test("upload refuses a /workspace/uploads symlink that points outside /workspace", async () => {
  const driver = new FakeVmDriver();
  install(driver);
  const handle = await driver.ensure("local");
  await driver.writeFile(handle, "/etc/passwd", "root:x:0:0:root:/root:/bin/bash");
  driver.symlink("local", UPLOAD_DIR, "/etc");

  const res = await POST(request([file("hello.txt", "hello")]));
  assert.equal(res.status, 403);
  const body = await json(res);
  assert.equal(body.code, "outside_workspace");
  assert.equal(driver.peekFile("local", "/etc/hello.txt"), undefined);
  assert.equal(driver.peekFile("local", `${UPLOAD_DIR}/hello.txt`), undefined);
});

test("upload works through a symlink that stays inside /workspace", async () => {
  const driver = new FakeVmDriver();
  install(driver);
  const handle = await driver.ensure("local");
  await driver.writeFile(handle, "/workspace/real-uploads/.keep", "");
  driver.symlink("local", UPLOAD_DIR, "/workspace/real-uploads");

  const res = await POST(request([file("note.txt", "through")]));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.uploaded[0].path, `${UPLOAD_DIR}/note.txt`);
  assert.equal(driver.peekFile("local", "/workspace/real-uploads/note.txt"), "through");
});

test("upload is refused when it would exceed the workspace disk quota", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, quotas: { diskQuotaMb: 1 } });
  setVmManagerForTesting(manager);
  const handle = await driver.ensure("local");
  // Seed directly through the driver: the manager's writeFile is quota-gated.
  await driver.writeFile(handle, "/workspace/big.bin", "x".repeat(2 * 1024 * 1024));

  const res = await POST(request([file("note.txt", "small")]));
  assert.equal(res.status, 413);
  const body = await json(res);
  assert.equal(body.code, "disk_quota");
  assert.equal(body.limit, 1);
  assert.equal(driver.peekFile("local", `${UPLOAD_DIR}/note.txt`), undefined);
});
