import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changedLineRange,
  DebouncedTrigger,
  deriveFileActivity,
  FileBrowserError,
  formatEditedAgo,
  highlightRangeForEdit,
  locateTextRange,
  mergeTouchedFiles,
  pruneTouchedFiles,
  TOUCHED_DOT_TTL_MS,
  WORKSPACE_ROOT,
  describeFilesError,
  fetchRecentWorkspaceFiles,
  fetchWorkspaceFile,
  fetchWorkspaceListing,
  formatBytes,
  joinWorkspacePath,
  normalizeWorkspacePath,
  parentWorkspacePath,
  workspaceFileDownloadUrl,
  type DebounceClock,
  type FetchLike,
  type FileEditEvent,
  type TouchedFile,
} from "./files";
import type { RunStreamItem } from "./useRunStream";

function fakeFetch(body: unknown, init?: ResponseInit & { raw?: string }): FetchLike {
  return async () =>
    new Response(init?.raw ?? JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
}

test("joins a directory and an entry into an absolute workspace path", () => {
  assert.equal(joinWorkspacePath("/workspace", "src"), "/workspace/src");
  assert.equal(joinWorkspacePath("/workspace/src", "app.ts"), "/workspace/src/app.ts");
  assert.equal(joinWorkspacePath("/workspace/", "notes.md"), "/workspace/notes.md");
  assert.equal(joinWorkspacePath("", "notes.md"), "/workspace/notes.md");
});

test("normalizes relative, duplicate-slash, and dot paths", () => {
  assert.equal(normalizeWorkspacePath("notes.md"), "/workspace/notes.md");
  assert.equal(normalizeWorkspacePath("/workspace//src/./app.ts"), "/workspace/src/app.ts");
  assert.equal(normalizeWorkspacePath(""), WORKSPACE_ROOT);
  assert.equal(normalizeWorkspacePath(null), WORKSPACE_ROOT);
});

test("path joining rejects traversal instead of clamping it", () => {
  for (const name of ["..", "../etc", "a/../../b"]) {
    assert.throws(
      () => joinWorkspacePath("/workspace/src", name),
      (err: unknown) => err instanceof FileBrowserError && err.kind === "forbidden",
      `expected ${name} to be rejected`,
    );
  }
});

test("paths outside the workspace and invalid names are refused", () => {
  assert.throws(
    () => normalizeWorkspacePath("/etc/passwd"),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "forbidden",
  );
  assert.throws(
    () => normalizeWorkspacePath("/workspace/a\u0000b"),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "invalid_path",
  );
  assert.throws(
    () => normalizeWorkspacePath("/workspace\\a"),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "invalid_path",
  );
  assert.throws(
    () => joinWorkspacePath("/workspace", "  "),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "invalid_path",
  );
});

test("parentWorkspacePath walks up and stops at the root", () => {
  assert.equal(parentWorkspacePath("/workspace/src/app.ts"), "/workspace/src");
  assert.equal(parentWorkspacePath("/workspace/src"), "/workspace");
  assert.equal(parentWorkspacePath("/workspace"), null);
});

test("fetchWorkspaceListing parses entries and builds the request URL", async () => {
  let seen = "";
  const fetchImpl: FetchLike = async (input) => {
    seen = String(input);
    return new Response(
      JSON.stringify({
        path: "/workspace",
        kind: "directory",
        root: "/workspace",
        parent: null,
        entries: [{ name: "src", path: "/workspace/src", type: "directory", size: 0 }],
      }),
      { status: 200 },
    );
  };

  const listing = await fetchWorkspaceListing("/workspace", { fetchImpl });
  assert.equal(listing.path, "/workspace");
  assert.equal(listing.parent, null);
  assert.equal(listing.entries[0].name, "src");
  assert.equal(listing.entries[0].type, "directory");
  assert.match(seen, /^\/api\/runtime\/vm\/files\?path=%2Fworkspace$/);
});

test("workspaceFileDownloadUrl builds a download=1 URL and refuses traversal", () => {
  assert.equal(
    workspaceFileDownloadUrl("/workspace/hello.txt"),
    "/api/runtime/vm/files?path=%2Fworkspace%2Fhello.txt&download=1",
  );
  assert.equal(
    workspaceFileDownloadUrl("notes.md"),
    "/api/runtime/vm/files?path=%2Fworkspace%2Fnotes.md&download=1",
  );
  assert.throws(
    () => workspaceFileDownloadUrl("../etc/passwd"),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "forbidden",
  );
});

test("fetchWorkspaceFile requests read=1 and keeps the binary/truncated flags", async () => {
  let seen = "";
  const fetchImpl: FetchLike = async (input) => {
    seen = String(input);
    return new Response(
      JSON.stringify({
        path: "/workspace/big.txt",
        kind: "file",
        size: 2_000_000,
        truncated: true,
        binary: false,
        limit: 1_048_576,
        content: "x",
      }),
      { status: 200 },
    );
  };

  const file = await fetchWorkspaceFile("/workspace/big.txt", { fetchImpl });
  assert.match(seen, /read=1/);
  assert.equal(file.truncated, true);
  assert.equal(file.limit, 1_048_576);
  assert.equal(file.content, "x");
});

test("maps API error codes to typed error states", async () => {
  const cases: Array<{ status: number; code: string; kind: FileBrowserError["kind"] }> = [
    { status: 401, code: "unauthorized", kind: "unauthorized" },
    { status: 403, code: "outside_workspace", kind: "forbidden" },
    { status: 404, code: "not_found", kind: "not_found" },
    { status: 400, code: "is_a_directory", kind: "bad_request" },
    { status: 501, code: "unsupported", kind: "unsupported" },
    { status: 500, code: "vm_error", kind: "server" },
  ];

  for (const c of cases) {
    await assert.rejects(
      fetchWorkspaceListing("/workspace", {
        fetchImpl: fakeFetch({ error: "nope", code: c.code }, { status: c.status }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof FileBrowserError);
        assert.equal(err.kind, c.kind);
        assert.equal(err.status, c.status);
        assert.equal(err.code, c.code);
        assert.equal(err.message, "nope");
        return true;
      },
      `expected ${c.status}/${c.code}`,
    );
  }
});

test("a network failure becomes a network error", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    fetchWorkspaceListing("/workspace", { fetchImpl }),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "network",
  );
});

test("a success response with the wrong shape is a malformed error", async () => {
  await assert.rejects(
    fetchWorkspaceListing("/workspace", { fetchImpl: fakeFetch({ nope: true }) }),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "malformed",
  );
  await assert.rejects(
    fetchWorkspaceListing("/workspace", { fetchImpl: fakeFetch(null, { raw: "not json" }) }),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "malformed",
  );
});

test("abort errors are rethrown untouched so effects can ignore them", async () => {
  const fetchImpl: FetchLike = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  await assert.rejects(
    fetchWorkspaceListing("/workspace", { fetchImpl }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("formatBytes and describeFilesError produce friendly text", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(describeFilesError(new FileBrowserError("not_found", "Missing.")), "Missing.");
  assert.equal(describeFilesError(new Error("boom")), "boom");
  assert.equal(describeFilesError("weird"), "Could not load the VM filesystem.");
});

test("fetchRecentWorkspaceFiles builds the recent=1 URL and parses files", async () => {
  let seen = "";
  const fetchImpl: FetchLike = async (input) => {
    seen = String(input);
    return new Response(
      JSON.stringify({
        path: "/workspace",
        kind: "recent",
        since: 1000,
        windowMs: 900_000,
        files: [
          { name: "app.ts", path: "/workspace/src/app.ts", size: 12, modifiedAt: 2000, contentType: "text/typescript" },
        ],
      }),
      { status: 200 },
    );
  };

  const recent = await fetchRecentWorkspaceFiles({ limit: 8, fetchImpl });
  assert.match(seen, /recent=1/);
  assert.match(seen, /limit=8/);
  assert.equal(recent.kind, "recent");
  assert.equal(recent.windowMs, 900_000);
  assert.equal(recent.files[0].path, "/workspace/src/app.ts");
  assert.equal(recent.files[0].contentType, "text/typescript");
});

test("fetchRecentWorkspaceFiles maps errors and malformed payloads", async () => {
  await assert.rejects(
    fetchRecentWorkspaceFiles({
      fetchImpl: fakeFetch({ error: "Sign in required.", code: "unauthorized" }, { status: 401 }),
    }),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "unauthorized",
  );
  await assert.rejects(
    fetchRecentWorkspaceFiles({ fetchImpl: fakeFetch({ kind: "directory", files: [] }) }),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "malformed",
  );
  await assert.rejects(
    fetchRecentWorkspaceFiles({
      fetchImpl: fakeFetch({ kind: "recent", files: [{ name: "x", path: "/workspace/x" }] }),
    }),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "malformed",
  );
  const fetchImpl: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    fetchRecentWorkspaceFiles({ fetchImpl }),
    (err: unknown) => err instanceof FileBrowserError && err.kind === "network",
  );
});

/* ── Live file changes (l8) ────────────────────────────────────────────── */

/** One stream item, with the fields the fold reads. */
function streamItem(
  seq: number,
  kind: string,
  payload: Record<string, unknown> = {},
  ts = 1_000 + seq,
): RunStreamItem {
  return { seq, kind, data: payload, ts, runId: "run_test" } as unknown as RunStreamItem;
}

function toolCall(
  seq: number,
  name: string,
  input: Record<string, unknown>,
  id?: string,
): RunStreamItem {
  const payload: Record<string, unknown> = { name, input };
  if (id !== undefined) payload.id = id;
  return streamItem(seq, "tool.call", payload);
}

function toolResult(seq: number, ok = true, id?: string): RunStreamItem {
  const payload: Record<string, unknown> = { ok };
  if (id !== undefined) payload.id = id;
  return streamItem(seq, "tool.result", payload);
}

test("deriveFileActivity maps write tool results to workspace paths", () => {
  const activity = deriveFileActivity([
    streamItem(1, "run.started"),
    toolCall(2, "Write", { file_path: "/workspace/hello.py" }),
    toolResult(3),
    toolCall(4, "Edit", { file_path: "src/app.ts", old_string: "a", new_string: "b" }),
    toolResult(5),
    toolCall(6, "MultiEdit", {
      file_path: "/workspace/notes.md",
      edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }],
    }),
    toolResult(7),
    toolCall(8, "NotebookEdit", { notebook_path: "/workspace/analysis.ipynb", new_source: "print(1)" }),
    toolResult(9),
  ]);
  assert.equal(activity.edits.length, 4);
  assert.equal(activity.edits[0].path, "/workspace/hello.py");
  assert.equal(activity.edits[0].tool, "Write");
  assert.deepEqual(activity.edits[0].newTexts, []);
  assert.equal(activity.edits[1].path, "/workspace/src/app.ts");
  assert.deepEqual(activity.edits[1].newTexts, ["b"]);
  assert.deepEqual(activity.edits[2].newTexts, ["y", "q"]);
  assert.equal(activity.edits[3].path, "/workspace/analysis.ipynb");
  assert.deepEqual(activity.edits[3].newTexts, ["print(1)"]);
  assert.equal(activity.seq, 9);
});

test("deriveFileActivity accepts MCP-prefixed names and alternate path keys", () => {
  const activity = deriveFileActivity([
    toolCall(1, "mcp__fs__write", { path: "/workspace/a.txt" }),
    toolResult(2),
    toolCall(3, "str_replace_editor", { file: "/workspace/b.txt" }),
    toolResult(4),
  ]);
  assert.deepEqual(
    activity.edits.map((edit) => edit.path),
    ["/workspace/a.txt", "/workspace/b.txt"],
  );
});

test("deriveFileActivity ignores failed, blocked, and unmatched results", () => {
  const activity = deriveFileActivity([
    toolCall(1, "Write", { file_path: "/workspace/failed.py" }),
    toolResult(2, false),
    toolCall(3, "Write", { file_path: "/workspace/blocked.py" }),
    streamItem(4, "tool.blocked", { name: "Write" }),
    toolResult(5),
    toolResult(6),
    toolCall(7, "Read", { file_path: "/workspace/read.py" }),
    toolResult(8),
  ]);
  assert.deepEqual(activity.edits, []);
  assert.equal(activity.bashAt, undefined);
});

test("deriveFileActivity pairs results by id, else by most recent open call", () => {
  const activity = deriveFileActivity([
    toolCall(1, "Write", { file_path: "/workspace/a.py" }, "call-a"),
    toolCall(2, "Bash", { command: "npm test" }, "call-b"),
    toolResult(3, true, "call-a"),
    toolResult(4, true, "call-b"),
  ]);
  assert.equal(activity.edits.length, 1);
  assert.equal(activity.edits[0].path, "/workspace/a.py");
  assert.equal(activity.bashAt, 1_004);
  assert.equal(activity.bashSeq, 4);

  const idLess = deriveFileActivity([
    toolCall(1, "Write", { file_path: "/workspace/a.py" }),
    toolCall(2, "Write", { file_path: "/workspace/b.py" }),
    toolResult(3),
  ]);
  assert.deepEqual(
    idLess.edits.map((edit) => edit.path),
    ["/workspace/b.py"],
  );
});

test("deriveFileActivity reads nested payloads and skips paths outside the workspace", () => {
  const activity = deriveFileActivity([
    streamItem(1, "tool.call", {
      data: { name: "Write", input: { file_path: "/workspace/nested.py" } },
    }),
    streamItem(2, "tool.result", { data: { ok: true } }),
    toolCall(3, "Write", { file_path: "/tmp/outside.txt" }),
    toolResult(4),
  ]);
  assert.deepEqual(
    activity.edits.map((edit) => edit.path),
    ["/workspace/nested.py"],
  );
});

test("deriveFileActivity drops calls orphaned by a new run", () => {
  const activity = deriveFileActivity([
    toolCall(1, "Write", { file_path: "/workspace/stale.py" }),
    streamItem(2, "run.started"),
    toolResult(3),
  ]);
  assert.deepEqual(activity.edits, []);
});

test("locateTextRange spans single and multi-line needles", () => {
  const content = "one\ntwo\nthree\nfour\n";
  assert.deepEqual(locateTextRange(content, "two"), { startLine: 2, endLine: 2 });
  assert.deepEqual(locateTextRange(content, "two\nthree"), { startLine: 2, endLine: 3 });
  assert.equal(locateTextRange(content, "five"), null);
  assert.equal(locateTextRange(content, ""), null);
});

test("changedLineRange diffs by common prefix and suffix", () => {
  assert.deepEqual(changedLineRange("a\nb\nc\n", "a\nB\nc\n"), { startLine: 2, endLine: 2 });
  assert.deepEqual(changedLineRange("a\nb\n", "a\nb\nc\nd\n"), { startLine: 3, endLine: 4 });
  assert.equal(changedLineRange("a\nb\n", "a\nb\n"), null);
  assert.deepEqual(changedLineRange("", "x\ny\n"), { startLine: 1, endLine: 2 });
  assert.equal(changedLineRange("x\ny\n", ""), null);
});

test("highlightRangeForEdit prefers the new text, else diffs the bytes", () => {
  assert.deepEqual(
    highlightRangeForEdit("a\nb\nc\n", "a\nB\nc\n", ["B"]),
    { startLine: 2, endLine: 2 },
  );
  assert.deepEqual(
    highlightRangeForEdit("a\nb\nc\n", "a\nB\nc\n", ["gone"]),
    { startLine: 2, endLine: 2 },
  );
  assert.equal(highlightRangeForEdit(undefined, "a\nb\n", []), null);
});

/** A clock the test drives by hand. */
class FakeClock implements DebounceClock {
  private nextId = 0;
  private readonly timers = new Map<unknown, () => void>();

  setTimeout(fn: () => void): unknown {
    const id = ++this.nextId;
    this.timers.set(id, fn);
    return id;
  }

  clearTimeout(id: unknown): void {
    this.timers.delete(id);
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  fireAll(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const fn of pending) fn();
  }
}

test("DebouncedTrigger fires only the latest call, once", () => {
  const clock = new FakeClock();
  const trigger = new DebouncedTrigger(clock);
  const fired: string[] = [];
  trigger.trigger(() => fired.push("first"), 500);
  assert.equal(trigger.isPending, true);
  trigger.trigger(() => fired.push("second"), 500);
  trigger.trigger(() => fired.push("third"), 500);
  assert.equal(clock.pendingCount, 1);
  clock.fireAll();
  assert.deepEqual(fired, ["third"]);
  assert.equal(trigger.isPending, false);
});

test("DebouncedTrigger cancel drops the pending call", () => {
  const clock = new FakeClock();
  const trigger = new DebouncedTrigger(clock);
  let fired = false;
  trigger.trigger(() => {
    fired = true;
  }, 500);
  trigger.cancel();
  assert.equal(trigger.isPending, false);
  clock.fireAll();
  assert.equal(fired, false);
});

test("formatEditedAgo labels fresh and aged writes", () => {
  const now = 1_000_000;
  assert.equal(formatEditedAgo(now - 1_000, now), "edited just now");
  assert.equal(formatEditedAgo(now - 12_000, now), "edited 12s ago");
  assert.equal(formatEditedAgo(now + 60_000, now), "edited just now");
});

test("pruneTouchedFiles drops dots past the TTL", () => {
  const now = 1_000_000;
  const touched: TouchedFile[] = [
    { path: "/workspace/fresh.py", at: now - 59_000, tool: "Write", newTexts: [] },
    { path: "/workspace/stale.py", at: now - TOUCHED_DOT_TTL_MS - 1, tool: "Edit", newTexts: [] },
  ];
  assert.deepEqual(
    pruneTouchedFiles(touched, now).map((entry) => entry.path),
    ["/workspace/fresh.py"],
  );
});

test("mergeTouchedFiles keeps one entry per path with the newest write", () => {
  const base: TouchedFile[] = [
    { path: "/workspace/a.py", at: 1_000, tool: "Write", newTexts: [] },
  ];
  const edits: FileEditEvent[] = [
    { path: "/workspace/b.py", at: 2_000, tool: "Edit", newTexts: ["x"], seq: 2 },
    { path: "/workspace/a.py", at: 3_000, tool: "Edit", newTexts: ["y"], seq: 3 },
  ];
  const merged = mergeTouchedFiles(base, edits);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].path, "/workspace/a.py");
  assert.equal(merged[0].at, 3_000);
  assert.deepEqual(merged[0].newTexts, ["y"]);
  assert.equal(merged[1].path, "/workspace/b.py");
});
