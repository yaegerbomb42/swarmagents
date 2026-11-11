import { NextResponse } from "next/server";
import { getProject } from "@/lib/engine/store";
import { assembleDeliverable } from "@/lib/engine/decomposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const record = getProject(projectId);
  if (!record) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const markdown = assembleDeliverable(record);
  return new NextResponse(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="deliverable-${projectId}.md"`,
    },
  });
}
