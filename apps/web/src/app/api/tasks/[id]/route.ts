import { NextRequest, NextResponse } from 'next/server';
import { engineForwardHeaders, requireAuth } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

/**
 * GET /api/tasks/[id]
 * Returns status and subtasks for a task/project by ID.
 * Proxies to the engine decomposition project endpoint.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = requireAuth(request);
  if (auth.ok !== true) return auth.response;

  const { id } = await ctx.params;
  const headers = engineForwardHeaders(request);

  try {
    // Try engine core task endpoint first
    const coreRes = await fetch(`${ENGINE_URL}/api/tasks/${id}`, {
      cache: 'no-store',
      headers,
    }).catch(() => null);

    if (coreRes?.ok) {
      return NextResponse.json(await coreRes.json());
    }

    // Fallback to decomposition project endpoint
    const projectRes = await fetch(
      `${ENGINE_URL}/api/decomposition/projects/${id}`,
      { cache: 'no-store', headers }
    );

    if (projectRes.ok) {
      const project = await projectRes.json();

      // Also fetch the task tree to get subtasks
      const treeRes = await fetch(
        `${ENGINE_URL}/api/decomposition/projects/${id}/tree`,
        { cache: 'no-store', headers }
      ).catch(() => null);

      const tree = treeRes?.ok ? await treeRes.json() : null;

      const tree_nodes = tree?.nodes
        ? Object.values(tree.nodes as Record<string, any>).map((n: any) => ({
            id: n.id,
            parent_id: n.parent_id,
            description: n.description,
            status: n.status,
            type: n.type,
            depth: n.depth,
            path: n.path,
            time_budget: n.time_budget,
            estimated_duration: n.estimated_duration,
            actual_duration: n.actual_duration,
            quality_score: n.quality_score,
            retry_count: n.retry_count,
            priority: n.priority,
            assigned_worker_id: n.assigned_worker_id,
            tags: n.tags?.length ? n.tags : (n.metadata?.task_type ? [n.metadata.task_type] : []),
          }))
        : [];

      // Flatten nodes into subtasks array for the zero dashboard
      const subtasks = tree_nodes.map((n) => ({
        id: n.id,
        title: n.description?.slice(0, 80) || n.id,
        description: n.description,
        status:
          n.status === 'completed'
            ? 'completed'
            : n.status === 'failed'
            ? 'failed'
            : n.status === 'executing' || n.status === 'assigned'
            ? 'running'
            : 'pending',
        assigned_worker: n.assigned_worker_id,
        type: n.type,
      }));

      return NextResponse.json({
        ...project,
        subtasks,
        tree_nodes,
        time_budget_sec: (project.time_budget || 1) * 3600,
        time_consumed_sec: project.time_consumed || 0,
        result: project.status === 'completed' ? `Project ${id} completed successfully.` : null,
      });
    }

    return NextResponse.json({ error: `Task ${id} not found` }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch task', detail: String(error) },
      { status: 500 }
    );
  }
}
