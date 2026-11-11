import { NextResponse } from "next/server";
import { getProject, recomputeTree } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const record = getProject(projectId);
  if (!record) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  recomputeTree(record.tree);
  return NextResponse.json(record.tree);
}
