/**
 * Project list/create (g5).
 *
 * GET  /api/projects  -> {projects: Project[]} for the caller
 * POST /api/projects  {name, repo?, workspacePath?, activeBranch?} -> 201 {project}
 *
 * Every project belongs to the signed-in account (x-swarm-user, set by the
 * middleware). There is no server-wide list and no cross-account lookup: the
 * store is keyed by the caller before any file is read.
 */

import { type NextRequest } from "next/server";
import { USER_HEADER } from "../../../lib/auth";
import { noStoreJson, noStoreRouteError, readJsonObject } from "../../../lib/http";
import { createProject, listProjects } from "../../../lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });
  return noStoreJson({ projects: listProjects(user) });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });

  const parsed = await readJsonObject(req, MAX_BODY_SIZE);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  try {
    const project = createProject(user, {
      name: body.name,
      repo: body.repo,
      workspacePath: body.workspacePath,
      activeBranch: body.activeBranch,
    });
    return noStoreJson({ project }, { status: 201 });
  } catch (err) {
    return noStoreRouteError(err, "Could not create the project.");
  }
}
