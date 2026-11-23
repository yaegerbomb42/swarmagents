import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceListing } from "../../../lib/client/files";
import { changedWorkspaceEntries } from "./FilesView";

const listing = (entries: WorkspaceListing["entries"], path = "/workspace"): WorkspaceListing =>
  ({ path, kind: "directory", root: "/workspace", parent: null, entries });
const entry = { name: "a.txt", path: "/workspace/a.txt", type: "file" as const, size: 1, modifiedAt: 1 };

test("workspace snapshots highlight new and changed files, not initial or other directories", () => {
  const first = listing([entry]);
  assert.deepEqual(changedWorkspaceEntries(undefined, first), []);
  assert.deepEqual(changedWorkspaceEntries(first, first), []);
  assert.deepEqual(changedWorkspaceEntries(first, listing([{ ...entry, modifiedAt: 2 }])), [entry.path]);
  assert.deepEqual(changedWorkspaceEntries(first, listing([entry, { ...entry, name: "b", path: "/workspace/b" }])), ["/workspace/b"]);
  assert.deepEqual(changedWorkspaceEntries(first, listing([entry], "/workspace/sub")), []);
});
