import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as listProjects, POST as createProjectRoute } from "./route";
import { DELETE as deleteProjectRoute, GET as getProjectRoute, PATCH as patchProjectRoute } from "./[id]/route";
import { DELETE as revokeShareRoute, POST as shareRoute } from "./[id]/share/route";
import { configureProjectStoreDir, getSharedProject } from "../../../lib/projects/store";

interface TestInit {
  method?: string;
  body?: string;
  headers?: HeadersInit;
}

function request(url: string, init: TestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  if (init.body) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    headers,
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

test("projects API: create, list, edit, share and revoke for the owner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-projects-api-"));
  configureProjectStoreDir(dir);
  try {
    assert.equal((await listProjects(request("/api/projects", {}, null))).status, 401);

    const created = await createProjectRoute(
      request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Atlas", repo: "yaegerbomb42/swarmagents", activeBranch: "main" }),
      }),
    );
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as { project: { id: string; name: string } };
    assert.equal(project.name, "Atlas");

    const list = await listProjects(request("/api/projects"));
    const body = (await list.json()) as { projects: Array<{ id: string }> };
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].id, project.id);

    const patched = await patchProjectRoute(
      request(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinnedNotes: ["run the suite"], activeBranch: "feat/g5" }),
      }),
      ctx(project.id),
    );
    assert.equal(patched.status, 200);
    const patchedBody = (await patched.json()) as { project: { pinnedNotes: string[]; activeBranch: string } };
    assert.deepEqual(patchedBody.project.pinnedNotes, ["run the suite"]);
    assert.equal(patchedBody.project.activeBranch, "feat/g5");

    // Another account sees a 404, never the project's contents.
    assert.equal((await getProjectRoute(request(`/api/projects/${project.id}`, {}, "bob"), ctx(project.id))).status, 404);
    assert.equal(
      (await patchProjectRoute(request(`/api/projects/${project.id}`, { method: "PATCH", body: "{}" }, "bob"), ctx(project.id))).status,
      404,
    );

    const shared = await shareRoute(request(`/api/projects/${project.id}/share`, { method: "POST" }), ctx(project.id));
    assert.equal(shared.status, 200);
    const sharedBody = (await shared.json()) as { share: { token: string } };
    assert.ok(getSharedProject(sharedBody.share.token));

    // Non-owners cannot rotate or revoke the link.
    assert.equal((await shareRoute(request(`/api/projects/${project.id}/share`, { method: "POST" }, "bob"), ctx(project.id))).status, 404);
    assert.equal(
      (await revokeShareRoute(request(`/api/projects/${project.id}/share`, { method: "DELETE" }, "bob"), ctx(project.id))).status,
      404,
    );

    assert.equal((await revokeShareRoute(request(`/api/projects/${project.id}/share`, { method: "DELETE" }), ctx(project.id))).status, 200);
    assert.equal(getSharedProject(sharedBody.share.token), null);

    assert.equal((await deleteProjectRoute(request(`/api/projects/${project.id}`, { method: "DELETE" }), ctx(project.id))).status, 200);
    assert.equal((await getProjectRoute(request(`/api/projects/${project.id}`), ctx(project.id))).status, 404);
  } finally {
    configureProjectStoreDir("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projects API: rejects malformed bodies and unknown ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-projects-api-"));
  configureProjectStoreDir(dir);
  try {
    assert.equal(
      (await createProjectRoute(request("/api/projects", { method: "POST", body: "{" }))).status,
      400,
    );
    assert.equal(
      (await createProjectRoute(request("/api/projects", { method: "POST", body: JSON.stringify({ name: "" }) }))).status,
      400,
    );
    assert.equal((await getProjectRoute(request("/api/projects/prj_nope"), ctx("prj_nope"))).status, 404);
    assert.equal(
      (await shareRoute(request("/api/projects/prj_nope/share", { method: "POST" }), ctx("prj_nope"))).status,
      404,
    );
  } finally {
    configureProjectStoreDir("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
