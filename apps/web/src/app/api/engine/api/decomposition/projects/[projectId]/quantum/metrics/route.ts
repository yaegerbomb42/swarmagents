import { NextResponse } from "next/server";
import { getProject } from "@/lib/engine/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The native engine routes tasks directly to DeepSeek V4 Flash; there is no
// separate quantum router. We expose a minimal, valid metrics shape so the
// optional "Quantum Brain" tab renders instead of erroring.
export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const record = getProject(projectId);
  if (!record) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  return NextResponse.json({
    current_pulse: null,
    router_state: {
      total_actions: record.tree.completed_nodes,
      action_counts: {},
      action_success_rates: {},
      attention_weights: [],
      avg_weight_variance: 0,
      neocortex_enabled: false,
    },
    recent_pulses: [],
    action_distribution: {},
    thinking_style_distribution: {},
    confidence_trend: [],
  });
}
