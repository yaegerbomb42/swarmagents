import { NextResponse } from 'next/server';
import { getLearningEngine } from '@/lib/learning-engine';

export async function GET() {
  try {
    const engine = getLearningEngine();
    const stats = engine.getStats();
    const config = engine.getConfig();

    return NextResponse.json({ stats, config });
  } catch (error) {
    console.error('Learning stats error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get stats' },
      { status: 500 }
    );
  }
}
