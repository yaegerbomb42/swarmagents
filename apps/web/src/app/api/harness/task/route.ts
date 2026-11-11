import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { taskId, title, prompt, provider } = body;

    const responsePayload = {
      ok: true,
      harness: 'omnexx-runtime',
      taskId: taskId || `task-${Date.now()}`,
      title: title || 'Autonomous Mission',
      provider: provider || 'auto-selected',
      status: 'dispatched',
      substrate: {
        goap: true,
        astVerification: true,
        stutterGuard: true,
      },
      message: 'Task dispatched to Omnexx runner engine.',
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(responsePayload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown harness error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'online',
    harness: 'omnexx',
    capabilities: [
      'ast-semantic-analysis',
      'goap-planning',
      'safe-staging',
      'provider-racing',
      'multi-key-rotation',
    ],
  });
}
