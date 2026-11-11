import { NextResponse } from "next/server";
import { deleteProject, getProject, toProjectResponse } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { projectId } = await params;
  const record = getProject(projectId);
  if (!record) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json(toProjectResponse(record));
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { projectId } = await params;
  const ok = deleteProject(projectId);
  if (!ok) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ message: "Project deleted" });
}
