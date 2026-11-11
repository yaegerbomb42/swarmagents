import { NextResponse } from 'next/server';
import { getLearningEngine } from '@/lib/learning-engine';

export async function GET() {
  try {
    const engine = getLearningEngine();
    const samples = engine.exportTrainingSamples();
    
    return new NextResponse(samples, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="training-samples.json"',
      },
    });
  } catch (error) {
    console.error('Learning export error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to export samples' },
      { status: 500 }
    );
  }
}
