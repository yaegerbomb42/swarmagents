import { NextResponse } from 'next/server';
import { getLearningEngine } from '@/lib/learning-engine';

export async function POST() {
  try {
    const engine = getLearningEngine();
    await engine.clearAll();
    return NextResponse.json({ success: true, message: 'All learning data cleared' });
  } catch (error) {
    console.error('Learning clear error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear data' },
      { status: 500 }
    );
  }
}
