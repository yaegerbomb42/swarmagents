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

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../lib/auth";
import { ProjectError, createProject, listProjects } from "../../../lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  return NextResponse.json({ projects: listProjects(user) });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400 });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  try {
    const project = createProject(user, {
      name: body.name,
      repo: body.repo,
      workspacePath: body.workspacePath,
      activeBranch: body.activeBranch,
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Could not create the project." }, { status: 500 });
  }
}
