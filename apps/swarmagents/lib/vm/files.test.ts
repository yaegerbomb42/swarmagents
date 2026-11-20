import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FILE_DOWNLOAD_BYTES,
  MAX_FILE_READ_BYTES,
  VmPathError,
  WORKSPACE_ROOT,
  downloadAttachmentFilename,
  downloadContentDisposition,
  downloadContentType,
  looksBinary,
  parentPath,
  resolveWorkspacePath,
} from "./files.js";

test("resolveWorkspacePath defaults to the workspace root", () => {
  assert.equal(resolveWorkspacePath(undefined), WORKSPACE_ROOT);
  assert.equal(resolveWorkspacePath(null), WORKSPACE_ROOT);
  assert.equal(resolveWorkspacePath(""), WORKSPACE_ROOT);
  assert.equal(resolveWorkspacePath("   "), WORKSPACE_ROOT);
});

test("resolveWorkspacePath accepts absolute and relative workspace paths", () => {
  assert.equal(resolveWorkspacePath("/workspace"), WORKSPACE_ROOT);
  assert.equal(resolveWorkspacePath("/workspace/notes.txt"), "/workspace/notes.txt");
  assert.equal(resolveWorkspacePath("/workspace/src/app.ts"), "/workspace/src/app.ts");
  assert.equal(resolveWorkspacePath("notes.txt"), "/workspace/notes.txt");
  assert.equal(resolveWorkspacePath("src/app.ts"), "/workspace/src/app.ts");
  assert.equal(resolveWorkspacePath("/workspace//src///app.ts"), "/workspace/src/app.ts");
  assert.equal(resolveWorkspacePath("/workspace/./notes.txt"), "/workspace/notes.txt");
  assert.equal(resolveWorkspacePath("/workspace/src/"), "/workspace/src");
});

test("resolveWorkspacePath rejects traversal", () => {
  for (const bad of [
    "../etc/passwd",
    "/workspace/../etc/passwd",
    "/workspace/../../etc/passwd",
    "..",
    "notes/../../secret",
    "/workspace/..",
  ]) {
    assert.throws(
      () => resolveWorkspacePath(bad),
      (err: unknown) => {
        assert.ok(err instanceof VmPathError, `expected VmPathError for ${bad}`);
        assert.equal(err.code, "outside_workspace");
        return true;
      },
      `expected ${bad} to be rejected`,
    );
  }
});

test("resolveWorkspacePath rejects paths outside the workspace", () => {
  for (const bad of ["/etc/passwd", "/workspace2/x", "/", "/root/.ssh"]) {
    assert.throws(
      () => resolveWorkspacePath(bad),
      (err: unknown) => {
        assert.ok(err instanceof VmPathError, `expected VmPathError for ${bad}`);
        assert.equal(err.code, "outside_workspace");
        return true;
      },
      `expected ${bad} to be rejected`,
    );
  }
});

test("resolveWorkspacePath rejects control characters and backslashes", () => {
  for (const bad of ["/workspace/a\u0000b", "/workspace/a\nb", "/workspace\\..\\etc"]) {
    assert.throws(
      () => resolveWorkspacePath(bad),
      (err: unknown) => {
        assert.ok(err instanceof VmPathError);
        assert.equal(err.code, "invalid_path");
        return true;
      },
      `expected ${bad} to be rejected`,
    );
  }
});

test("parentPath walks up the workspace tree", () => {
  assert.equal(parentPath("/workspace"), null);
  assert.equal(parentPath("/workspace/notes.txt"), "/workspace");
  assert.equal(parentPath("/workspace/src/app.ts"), "/workspace/src");
});

test("looksBinary detects NUL bytes and control-heavy payloads", () => {
  assert.equal(looksBinary(Buffer.from("hello world")), false);
  assert.equal(looksBinary(Buffer.from("line1\nline2\n")), false);
  assert.equal(looksBinary(Buffer.from("héllo — ünicode")), false);
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
  assert.equal(looksBinary(Buffer.from([0x01, 0x02, 0x03, 0x04])), true);
  assert.equal(looksBinary(Buffer.alloc(0)), false);
});

test("the read cap is 1 MB", () => {
  assert.equal(MAX_FILE_READ_BYTES, 1024 * 1024);
});

test("the download cap is 10 MB", () => {
  assert.equal(MAX_FILE_DOWNLOAD_BYTES, 10 * 1024 * 1024);
});

test("downloadContentType maps common extensions and falls back safely", () => {
  assert.equal(downloadContentType("notes.txt"), "text/plain");
  assert.equal(downloadContentType("photo.PNG"), "image/png");
  assert.equal(downloadContentType("data.json"), "application/json");
  assert.equal(downloadContentType("doc.pdf"), "application/pdf");
  assert.equal(downloadContentType("archive.zip"), "application/zip");
  assert.equal(downloadContentType("page.html"), "text/html");
  assert.equal(downloadContentType("no-extension"), "application/octet-stream");
  assert.equal(downloadContentType("weird.xyz"), "application/octet-stream");
});

test("download attachment filenames are header-safe", () => {
  assert.equal(downloadAttachmentFilename("/workspace/hello.txt"), "hello.txt");
  assert.equal(downloadAttachmentFilename("/workspace/my file (1).png"), "my file (1).png");
  assert.equal(downloadAttachmentFilename('/workspace/a"b.txt'), "ab.txt");
  assert.equal(downloadAttachmentFilename("/workspace/"), "download");
  const disposition = downloadContentDisposition("/workspace/report.pdf");
  assert.match(disposition, /^attachment; filename="report\.pdf"/);
  assert.match(disposition, /filename\*=UTF-8''report\.pdf/);
});
