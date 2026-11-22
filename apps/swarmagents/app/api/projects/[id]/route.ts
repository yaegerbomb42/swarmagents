/**
 * One project (g5): read, edit and delete. Owner-only.
 *
 * GET    /api/projects/{id} -> {project}
 * PATCH  /api/projects/{id} {name?, repo?, workspacePath?, activeBranch?, openFiles?, pinnedNotes?}
 * DELETE /api/projects/{id}
 *
 * A project id owned by a different account resolves to 404, never 403: the
 * caller learns nothing about another user's project.
 */

import { type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { noStoreJson, noStoreRouteError, readJsonObject } from "../../../../lib/http";
import { deleteProject, getProject, isProjectId, updateProject } from "../../../../lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 128 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function notFound() {
  return noStoreJson({ error: "Project not found." }, { status: 404 });
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  const project = getProject(user, id);
  if (!project) return notFound();
  return noStoreJson({ project });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();

  const parsed = await readJsonObject(req, MAX_BODY_SIZE);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  try {
    const project = updateProject(user, id, {
      name: body.name,
      repo: body.repo,
      workspacePath: body.workspacePath,
      activeBranch: body.activeBranch,
      openFiles: body.openFiles,
      pinnedNotes: body.pinnedNotes,
      computeTarget: body.computeTarget,
    });
    return noStoreJson({ project });
  } catch (err) {
    return noStoreRouteError(err, "Could not update the project.");
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  const deleted = deleteProject(user, id);
  if (!deleted) return notFound();
  return noStoreJson({ ok: true });
}
