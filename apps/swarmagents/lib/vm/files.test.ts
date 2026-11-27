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
  foldRecentDir,
  looksBinary,
  rankRecentFiles,
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

// ---------------------------------------------------------------------------
// recent-scan fold and ranking (GET ?recent=1 helpers)
// ---------------------------------------------------------------------------

test("foldRecentDir keeps in-window files with their content type and queues subdirs", () => {
  const now = 1_000_000_000;
  const budget = { visited: 0 };
  const { files, subdirs } = foldRecentDir(
    [
      { name: "new.txt", path: "/workspace/new.txt", type: "file", size: 3, modifiedAt: now },
      { name: "old.txt", path: "/workspace/old.txt", type: "file", size: 4, modifiedAt: now - 999_999 },
      { name: "src", path: "/workspace/src", type: "directory", size: 0 },
      { name: "nomtime.bin", path: "/workspace/nomtime.bin", type: "file", size: 9 },
    ],
    now - 60_000,
    budget,
  );
  assert.deepEqual(files, [
    { name: "new.txt", path: "/workspace/new.txt", size: 3, modifiedAt: now, contentType: "text/plain" },
  ]);
  assert.deepEqual(subdirs, ["/workspace/src"]);
  assert.equal(budget.visited, 4);
});

test("rankRecentFiles sorts most-recent-first with a path tiebreak and caps the list", () => {
  const ranked = rankRecentFiles(
    [
      { name: "a", path: "/workspace/b.txt", size: 1, modifiedAt: 100, contentType: "text/plain" },
      { name: "b", path: "/workspace/c.txt", size: 1, modifiedAt: 300, contentType: "text/plain" },
      { name: "c", path: "/workspace/a.txt", size: 1, modifiedAt: 200, contentType: "text/plain" },
      { name: "d", path: "/workspace/aa.txt", size: 1, modifiedAt: 200, contentType: "text/plain" },
    ],
    2,
  );
  assert.deepEqual(ranked.map((f) => f.path), ["/workspace/c.txt", "/workspace/a.txt"]);
});

// ---- recent scan: single find exec (review follow-up for #321) -------------

test("recentFindArgv: one pruned, depth-capped find; argv only", async () => {
  const { recentFindArgv, RECENT_SCAN_PRUNE_DIRS, MAX_RECENT_WALK_DEPTH } = await import("./files");
  const argv = recentFindArgv("/workspace", 15 * 60_000);
  assert.equal(argv[0], "find");
  assert.equal(argv[1], "/workspace");
  assert.equal(argv[argv.indexOf("-maxdepth") + 1], String(MAX_RECENT_WALK_DEPTH + 1));
  assert.equal(argv[argv.indexOf("-mmin") + 1], "-15");
  for (const dir of RECENT_SCAN_PRUNE_DIRS) assert.ok(argv.includes(dir), `prunes ${dir}`);
  assert.ok(argv.indexOf("-prune") < argv.indexOf("-type"));
  assert.equal(recentFindArgv("/workspace", 1)[recentFindArgv("/workspace", 1).indexOf("-mmin") + 1], "-1");
});

test("parseRecentFind: parses mtime/size/path, drops stale and malformed lines", async () => {
  const { parseRecentFind } = await import("./files");
  const now = Date.now();
  const fresh = (now - 5_000) / 1000;
  const stale = (now - 3_600_000) / 1000;
  const out = [
    `${fresh.toFixed(6)}\t12\t/workspace/out/chart.png`,
    `${stale.toFixed(6)}\t3\t/workspace/old.txt`,
    "garbage line",
    `${fresh.toFixed(6)}\t7\t/workspace/dir with space/a b.csv`,
    "",
  ].join("\n");
  const files = parseRecentFind(out, now - 60_000);
  assert.deepEqual(files.map((f) => f.path), ["/workspace/out/chart.png", "/workspace/dir with space/a b.csv"]);
  assert.equal(files[0].name, "chart.png");
  assert.equal(files[0].size, 12);
  assert.equal(files[0].contentType, "image/png");
  assert.ok(Math.abs(files[0].modifiedAt - (now - 5_000)) < 5);
});

test("foldRecentDir: never descends into node_modules/.git", async () => {
  const { foldRecentDir } = await import("./files");
  const res = foldRecentDir(
    [
      { name: "node_modules", path: "/workspace/node_modules", type: "directory", size: 0 },
      { name: ".git", path: "/workspace/.git", type: "directory", size: 0 },
      { name: "src", path: "/workspace/src", type: "directory", size: 0 },
    ],
    0,
    { visited: 0 },
  );
  assert.deepEqual(res.subdirs, ["/workspace/src"]);
});
