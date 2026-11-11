import { NextRequest, NextResponse } from 'next/server';
import { getLearningEngine } from '@/lib/learning-engine';
import { engineFetch } from '@/lib/engineClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query } = body;

    if (!query) {
      return NextResponse.json(
        { error: 'Missing required field: query' },
        { status: 400 },
      );
    }

    const engine = getLearningEngine();
    const local = await engine.retrieveContext(query);

    const [ep, sem] = await Promise.all([
      engineFetch<{ entries?: unknown[]; note?: string }>('/memory/episodic'),
      engineFetch<{ results?: unknown[]; entries?: unknown[]; note?: string }>(
        '/memory/semantic',
      ),
    ]);

    return NextResponse.json({
      ...local,
      engine_memory: {
        episodic: ep.ok ? ep.data.entries || [] : [],
        semantic: sem.ok ? sem.data.results || sem.data.entries || [] : [],
        notes: [
          ep.ok === false ? ep.error : null,
          sem.ok === false ? sem.error : null,
        ].filter(Boolean),
      },
    });
  } catch (error) {
    console.error('Learning retrieve error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to retrieve context' },
      { status: 500 },
    );
  }
}
