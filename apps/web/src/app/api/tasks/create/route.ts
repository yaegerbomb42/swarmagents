import { NextRequest, NextResponse } from 'next/server';
import { engineForwardHeaders, requireAuth } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

/**
 * POST /api/tasks/create
 * Creates a new task and triggers auto-decomposition via the engine backend.
 * Body: { title, description, priority?, requirements?, auto_decompose?, source? }
 */
export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth.ok !== true) return auth.response;

  try {
    const body = await request.json();
    const headers = engineForwardHeaders(request);

    // Try the engine-core task creation endpoint first
    const taskRes = await fetch(`${ENGINE_URL}/api/tasks/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }).catch(() => null);

    if (taskRes?.ok) {
      const data = await taskRes.json();
      return NextResponse.json(data);
    }

      // Fall back to the decomposition projects endpoint
      let projectDesc = body.description || body.title || 'Unnamed task';
      if (body.github_repo) {
        projectDesc += `\n\n[GitHub Repository URL to pull/index]: ${body.github_repo}`;
      }
      if (body.attached_files && body.attached_files.length > 0) {
        projectDesc += `\n\n[Attached Files]: ${body.attached_files.join(', ')}`;
      }
      if (body.attached_images && body.attached_images.length > 0) {
        projectDesc += `\n\n[Attached Images]: ${body.attached_images.join(', ')}`;
      }

      const projectRes = await fetch(`${ENGINE_URL}/api/decomposition/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description: projectDesc,
          deliverable_type: body.deliverable_type || 'OTHER',
          time_budget_hours: body.time_budget_hours || 1.0,
          metadata: {
            title: body.title,
            priority: body.priority,
            source: body.source || 'api',
            auto_decompose: body.auto_decompose ?? true,
            github_repo: body.github_repo,
            attached_files: body.attached_files,
            attached_images: body.attached_images,
          },
        }),
      });

    if (projectRes.ok) {
      const project = await projectRes.json();
      // Auto-execute if requested
      if (body.auto_decompose !== false && project.project_id) {
        fetch(`${ENGINE_URL}/api/decomposition/projects/${project.project_id}/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        }).catch(() => {/* background execution — ignore errors */});
      }
      return NextResponse.json({
        task: {
          id: project.project_id,
          title: body.title || body.description?.slice(0, 80),
          status: project.status,
          project_id: project.project_id,
          tree_id: project.tree_id,
        },
        project,
      });
    }

    const errText = await projectRes.text().catch(() => 'Unknown error');
    return NextResponse.json(
      { error: 'Failed to create task', code: 'create_failed', detail: errText },
      { status: projectRes.status || 500 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Task creation failed', code: 'create_error', detail: String(error) },
      { status: 500 }
    );
  }
}

/**
 * GET /api/tasks/create
 * Returns task creation schema info.
 */
export async function GET() {
  return NextResponse.json({
    endpoint: 'POST /api/tasks/create',
    body: {
      title: 'string (required)',
      description: 'string (required)',
      priority: 'number 1-10 (optional, default 5)',
      requirements: 'string[] (optional)',
      auto_decompose: 'boolean (optional, default true)',
      time_budget_hours: 'number (optional, default 1.0)',
      source: 'string (optional)',
    },
  });
}
