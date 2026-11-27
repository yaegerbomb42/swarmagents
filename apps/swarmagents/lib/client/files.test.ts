import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FileBrowserError,
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
  type FetchLike,
} from "./files";

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
