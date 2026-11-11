import { NextResponse } from "next/server";
import { getProject, putProject } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const record = getProject(projectId);
  if (!record) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  record.status = "cancelled";
  record.tree.status = "cancelled";
  putProject(record);
  return NextResponse.json({ message: "Project cancelled" });
}
