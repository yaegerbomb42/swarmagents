import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { DeliverableType } from "@/types/decomposition";
import { isDeepSeekConfigured } from "@/lib/deepseek";
import {
  listProjects,
  putProject,
  toProjectResponse,
  type ProjectRecord,
} from "@/lib/engine/store";
import { createEmptyTree, decomposeProject } from "@/lib/engine/decomposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const projects = listProjects().map(toProjectResponse);
  return NextResponse.json({
    projects,
    total: projects.length,
    limit: projects.length,
    offset: 0,
  });
}

export async function POST(req: NextRequest) {
  if (!isDeepSeekConfigured()) {
    return NextResponse.json(
      { error: "DeepSeek not configured", detail: "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const description: string = (body.description || "").trim();
  if (!description) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }

  const deliverableType = (body.deliverable_type || DeliverableType.OTHER) as DeliverableType;
  const budgetHours = Number(body.time_budget_hours) || 1;
  const projectId = randomUUID();
  const budgetSeconds = Math.round(budgetHours * 3600);

  const record: ProjectRecord = {
    id: projectId,
    description,
    deliverable_type: deliverableType,
    time_budget_seconds: budgetSeconds,
    status: "decomposing",
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    tree: createEmptyTree(projectId, deliverableType, budgetSeconds),
    error: null,
  };
  putProject(record);

  try {
    await decomposeProject(record);
  } catch (err) {
    record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
    putProject(record);
    return NextResponse.json(
      { error: "Decomposition failed", detail: record.error },
      { status: 502 }
    );
  }

  return NextResponse.json(toProjectResponse(record), { status: 201 });
}
