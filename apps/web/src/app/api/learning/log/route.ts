import { NextRequest, NextResponse } from 'next/server';
import { getLearningEngine } from '@/lib/learning-engine';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userPrompt, modelResponse, taskType, success, userId, sessionId } = body;

    if (!userPrompt || !modelResponse) {
      return NextResponse.json(
        { error: 'Missing required fields: userPrompt, modelResponse' },
        { status: 400 }
      );
    }

    const engine = getLearningEngine();
    const id = await engine.logConversation({
      userPrompt,
      modelResponse,
      taskType,
      success,
      userId,
      sessionId: sessionId || crypto.randomUUID(),
    });

    return NextResponse.json({ id, success: true });
  } catch (error) {
    console.error('Learning log error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to log conversation' },
      { status: 500 }
    );
  }
}
