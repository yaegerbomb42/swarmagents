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

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import {
  ProjectError,
  deleteProject,
  getProject,
  isProjectId,
  updateProject,
} from "../../../../lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 128 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound() {
  return NextResponse.json({ error: "Project not found." }, { status: 404 });
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  const project = getProject(user, id);
  if (!project) return notFound();
  return NextResponse.json({ project });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();

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
    const project = updateProject(user, id, {
      name: body.name,
      repo: body.repo,
      workspacePath: body.workspacePath,
      activeBranch: body.activeBranch,
      openFiles: body.openFiles,
      pinnedNotes: body.pinnedNotes,
      computeTarget: body.computeTarget,
    });
    return NextResponse.json({ project });
  } catch (err) {
    if (err instanceof ProjectError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Could not update the project." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  const deleted = deleteProject(user, id);
  if (!deleted) return notFound();
  return NextResponse.json({ ok: true });
}
