import { NextResponse } from "next/server";
import { getProject } from "@/lib/engine/store";
import { executeProject } from "@/lib/engine/decomposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const record = getProject(projectId);
  if (!record) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    await executeProject(projectId);
  } catch (err) {
    return NextResponse.json(
      { success: false, project_id: projectId, tree_id: record.tree.id, message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: record.tree.status === "completed",
    project_id: projectId,
    tree_id: record.tree.id,
    message: `Execution ${record.tree.status}`,
  });
}
