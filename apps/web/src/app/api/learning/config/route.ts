import { NextRequest, NextResponse } from 'next/server';
import { getLearningEngine } from '@/lib/learning-engine';
import type { LearningConfig } from '@/types/learning';

export async function GET() {
  try {
    const engine = getLearningEngine();
    const config = engine.getConfig();
    return NextResponse.json(config);
  } catch (error) {
    console.error('Learning config GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get config' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const updates: Partial<LearningConfig> = await request.json();
    const engine = getLearningEngine();
    engine.updateConfig(updates);
    const config = engine.getConfig();
    return NextResponse.json(config);
  } catch (error) {
    console.error('Learning config POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update config' },
      { status: 500 }
    );
  }
}
