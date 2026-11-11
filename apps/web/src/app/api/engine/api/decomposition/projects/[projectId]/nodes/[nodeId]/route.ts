import { NextResponse } from "next/server";
import { getProject } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ projectId: string; nodeId: string }> }
) {
  const { projectId, nodeId } = await params;
  const record = getProject(projectId);
  if (!record) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const node = record.tree.nodes[nodeId];
  if (!node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }
  return NextResponse.json(node);
}
