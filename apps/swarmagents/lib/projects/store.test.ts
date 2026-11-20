import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDirName } from "../providers/store";
import {
  MAX_COMMANDS,
  MAX_OPEN_FILES,
  MAX_PINNED_NOTES,
  ProjectError,
  configureProjectStoreDir,
  createProject,
  createShareLink,
  deleteProject,
  ensureShareIndex,
  getProject,
  getSharedProject,
  isProjectId,
  listProjects,
  mutateProject,
  resolveShareOwner,
  revokeShareLink,
  shareIndexEntryPath,
  updateProject,
  userProjectsFilePath,
} from "./store";

function withStore(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-projects-"));
  configureProjectStoreDir(dir);
  try {
    fn(dir);
  } finally {
    configureProjectStoreDir("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("projects store: create, list, get and update are per account", () => {
  withStore(() => {
    const alice = createProject("alice", { name: "Atlas", repo: "yaegerbomb42/swarmagents", activeBranch: "main" });
    assert.match(alice.id, /^prj_[a-f0-9-]+$/i);
    assert.ok(isProjectId(alice.id));
    assert.equal(alice.workspacePath, "/workspace");

    const bob = createProject("bob", { name: "Other" });
    assert.equal(listProjects("alice").length, 1);
    assert.equal(listProjects("bob").length, 1);
    // Another account can never resolve the id, even with the exact value.
    assert.equal(getProject("bob", alice.id), null);
    assert.equal(getProject("alice", bob.id), null);

    const updated = updateProject("alice", alice.id, {
      pinnedNotes: ["Always run the unit suite before pushing."],
      activeBranch: "feat/g5",
      openFiles: ["apps/swarmagents/lib/runtime/manager.ts"],
    });
    assert.equal(updated.activeBranch, "feat/g5");
    assert.deepEqual(updated.pinnedNotes, ["Always run the unit suite before pushing."]);

    assert.equal(deleteProject("bob", alice.id), false);
    assert.equal(deleteProject("alice", alice.id), true);
    assert.equal(getProject("alice", alice.id), null);
  });
});

test("projects store: lists are capped and malformed fields are ignored", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Caps" });
    mutateProject("alice", project.id, (current) => {
      current.commands = Array.from({ length: 30 }, (_, index) => ({
        command: `echo ${index}`,
        exitCode: 0,
        at: index,
      }));
      current.openFiles = Array.from({ length: 80 }, (_, index) => `file-${index}.ts`);
      current.pinnedNotes = Array.from({ length: 30 }, (_, index) => `note ${index}`);
    });
    const read = getProject("alice", project.id);
    assert.ok(read);
    assert.equal(read.commands.length, MAX_COMMANDS);
    assert.equal(read.commands.at(-1)?.command, "echo 29");
    assert.equal(read.openFiles.length, MAX_OPEN_FILES);
    assert.equal(read.pinnedNotes.length, MAX_PINNED_NOTES);

    // A file whose owner does not match is ignored entirely.
    const file = userProjectsFilePath("alice");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.userId = "bob";
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual(listProjects("alice"), []);
  });
});

test("projects store: rejects invalid input with a typed error", () => {
  withStore(() => {
    assert.throws(() => createProject("alice", { name: "   " }), ProjectError);
    const project = createProject("alice", { name: "Valid" });
    assert.throws(() => updateProject("alice", project.id, { name: "" }), ProjectError);
    assert.throws(() => updateProject("alice", "not-a-project", { name: "x" }), ProjectError);
  });
});

test("projects store: share links are read-only, resolve by token, and revoke", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Shared", repo: "yaegerbomb42/swarmagents", activeBranch: "main" });
    updateProject("alice", project.id, {
      pinnedNotes: ["no secrets here"],
      openFiles: ["src/app.ts"],
    });
    mutateProject("alice", project.id, (current) => {
      current.threads = ["sess_1", "run_2"];
      current.commands = [
        { command: "npm test", exitCode: 1, at: 1 },
        { command: "OPENAI_API_KEY=sk-abcdefgh12345678 curl https://api.example", exitCode: 0, at: 2 },
      ];
      current.lastTest = {
        command: "npm test",
        ok: false,
        exitCode: 1,
        failed: 2,
        passed: 10,
        failing: ["FAIL src/app.test.ts"],
        outputTail: "Authorization: Bearer abcdefgh12345678",
        at: 1,
      };
    });

    const share = createShareLink("alice", project.id);
    assert.match(share.token, /^[a-f0-9]{48}$/);
    assert.equal(getSharedProject(share.token)?.name, "Shared");

    const view = getSharedProject(share.token);
    assert.ok(view);
    assert.equal(view.threadCount, 2);
    assert.equal(view.lastTest?.failed, 2);
    // Secrets are scrubbed before a snapshot leaves the account.
    assert.equal(JSON.stringify(view).includes("sk-abcdefgh12345678"), false);
    assert.equal(JSON.stringify(view).includes("abcdefgh12345678"), false);
    assert.match(view.commands.at(-1)?.command ?? "", /OPENAI_API_KEY=\[redacted\]/);
    // The public view never carries the owner id or a live token.
    assert.equal("userId" in view, false);
    assert.equal("share" in view, false);

    // Another account cannot revoke it; the owner can.
    assert.equal(revokeShareLink("bob", project.id), false);
    assert.equal(revokeShareLink("alice", project.id), true);
    assert.equal(getSharedProject(share.token), null);
    assert.equal(getSharedProject("not-a-token"), null);
  });
});

test("projects store: resolveShareOwner gates guests without exposing the owner", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Shared" });
    // A project with no share link has no token to resolve.
    assert.equal(resolveShareOwner("0".repeat(48)), null);

    const share = createShareLink("alice", project.id);
    assert.deepEqual(resolveShareOwner(share.token), {
      ownerId: "alice",
      projectId: project.id,
    });

    // Malformed and missing tokens never resolve.
    assert.equal(resolveShareOwner("not-a-token"), null);
    assert.equal(resolveShareOwner("f".repeat(48)), null);

    // A revoked token stops resolving.
    revokeShareLink("alice", project.id);
    assert.equal(resolveShareOwner(share.token), null);
  });
});

/** Run `fn` while every fs.readFileSync call is recorded. */
function recordReads(fn: () => void): string[] {
  const reads: string[] = [];
  const original = fs.readFileSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    reads.push(String(file));
    return (original as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  try {
    fn();
  } finally {
    fs.readFileSync = original;
  }
  return reads;
}

test("projects store: share links resolve through the token index", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Indexed" });
    const share = createShareLink("alice", project.id);

    // The index file maps the token straight at the owner and the project.
    const entryFile = shareIndexEntryPath(share.token);
    assert.ok(fs.existsSync(entryFile), "the share index entry must exist");
    const entry = JSON.parse(fs.readFileSync(entryFile, "utf-8"));
    assert.equal(entry.token, share.token);
    assert.equal(entry.ownerId, "alice");
    assert.equal(entry.projectId, project.id);

    // The link resolves through the index.
    assert.equal(getSharedProject(share.token)?.name, "Indexed");
  });
});

test("projects store: a token miss never reads an account's project file", () => {
  withStore(() => {
    const alice = createProject("alice", { name: "A" });
    createShareLink("alice", alice.id);
    const bob = createProject("bob", { name: "B" });
    createShareLink("bob", bob.id);

    let view: ReturnType<typeof getSharedProject> = null;
    const reads = recordReads(() => {
      view = getSharedProject("0".repeat(48));
    });
    assert.equal(view, null, "an unknown token must not resolve");
    assert.deepEqual(
      reads.filter((file) => file.endsWith("projects.json")),
      [],
      `a miss must not read any projects.json (read: ${reads.join(", ")})`,
    );
  });
});

test("projects store: a share hit reads only the owner's project file", () => {
  withStore(() => {
    const alice = createProject("alice", { name: "A" });
    const share = createShareLink("alice", alice.id);
    for (let i = 0; i < 5; i++) createProject(`other-${i}`, { name: "Noise" });

    let view: ReturnType<typeof getSharedProject> = null;
    const reads = recordReads(() => {
      view = getSharedProject(share.token);
    });
    assert.equal((view as ReturnType<typeof getSharedProject>)?.name, "A");
    const projectReads = reads.filter((file) => file.endsWith("projects.json"));
    assert.equal(projectReads.length, 1, `only the owner's file may be read (read: ${reads.join(", ")})`);
    assert.ok(projectReads[0].includes(userDirName("alice")), projectReads[0]);
  });
});

test("projects store: revoking a share removes its index entry", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Shared" });
    const share = createShareLink("alice", project.id);
    assert.ok(fs.existsSync(shareIndexEntryPath(share.token)));

    assert.equal(revokeShareLink("alice", project.id), true);
    assert.equal(fs.existsSync(shareIndexEntryPath(share.token)), false, "a revoked token is dropped from the index");
    assert.equal(getSharedProject(share.token), null);
  });
});

test("projects store: rotating a share replaces its index entry", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Shared" });
    const first = createShareLink("alice", project.id);
    const second = createShareLink("alice", project.id);
    assert.notEqual(first.token, second.token);

    assert.equal(fs.existsSync(shareIndexEntryPath(first.token)), false, "the rotated token is dropped");
    assert.ok(fs.existsSync(shareIndexEntryPath(second.token)), "the new token is indexed");
    assert.equal(getSharedProject(first.token), null, "the old link stops resolving");
    assert.equal(getSharedProject(second.token)?.name, "Shared");
  });
});

test("projects store: deleting a project removes its index entry", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Shared" });
    const share = createShareLink("alice", project.id);
    assert.ok(fs.existsSync(shareIndexEntryPath(share.token)));

    assert.equal(deleteProject("alice", project.id), true);
    assert.equal(fs.existsSync(shareIndexEntryPath(share.token)), false);
    assert.equal(getSharedProject(share.token), null);
  });
});

test("projects store: the index entry is verified against the owner's project", () => {
  withStore(() => {
    const project = createProject("alice", { name: "Shared" });
    const share = createShareLink("alice", project.id);
    assert.ok(getSharedProject(share.token));

    // The owner revokes the link behind the index's back: the stale entry
    // must not resolve and must be dropped.
    const file = userProjectsFilePath("alice");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.projects[0].share.revokedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(raw));

    assert.equal(getSharedProject(share.token), null, "a revoked share never resolves");
    assert.equal(fs.existsSync(shareIndexEntryPath(share.token)), false, "the stale entry is dropped");
  });
});

test("projects store: the index migrates links that existed before it", () => {
  withStore((dir) => {
    // An account file written by an older release: the share lives in
    // projects.json only, there is no index entry yet.
    const token = "a".repeat(48);
    const userDir = path.join(dir, "users", userDirName("legacy"));
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, "projects.json"),
      JSON.stringify({
        schema: "swarm-projects",
        version: 1,
        userId: "legacy",
        projects: [
          {
            id: "prj_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            userId: "legacy",
            name: "Legacy",
            workspacePath: "/workspace",
            openFiles: [],
            commands: [],
            lastTest: null,
            pinnedNotes: [],
            threads: [],
            createdAt: 1,
            updatedAt: 2,
            share: { token, createdAt: 2 },
          },
        ],
      }),
    );

    assert.equal(fs.existsSync(shareIndexEntryPath(token)), false);
    assert.equal(ensureShareIndex(), 1, "the migration indexes the legacy link");
    assert.ok(fs.existsSync(shareIndexEntryPath(token)));
    assert.equal(getSharedProject(token)?.name, "Legacy");
  });
});

test("projects store: the migration never indexes a revoked link", () => {
  withStore((dir) => {
    const token = "b".repeat(48);
    const userDir = path.join(dir, "users", userDirName("legacy"));
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, "projects.json"),
      JSON.stringify({
        schema: "swarm-projects",
        version: 1,
        userId: "legacy",
        projects: [
          {
            id: "prj_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            userId: "legacy",
            name: "Legacy",
            workspacePath: "/workspace",
            openFiles: [],
            commands: [],
            lastTest: null,
            pinnedNotes: [],
            threads: [],
            createdAt: 1,
            updatedAt: 2,
            share: { token, createdAt: 2, revokedAt: 3 },
          },
        ],
      }),
    );

    assert.equal(ensureShareIndex(), 0);
    assert.equal(fs.existsSync(shareIndexEntryPath(token)), false);
    assert.equal(getSharedProject(token), null);
  });
});
