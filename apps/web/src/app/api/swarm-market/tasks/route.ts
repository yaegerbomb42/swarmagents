/// <reference types="node" />

import { NextRequest, NextResponse } from 'next/server';
import { createTask, listTasks, completeTask } from '@/lib/swarm-market/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const task = createTask({
      title: body.title,
      description: body.description || '',
      difficulty: body.difficulty || 5,
      reward_points: body.reward_points || 100,
      required_dna: body.required_dna,
      task_type: body.task_type || 'standard',
    });
    return NextResponse.json({ ok: true, task });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const tasks = listTasks();
    return NextResponse.json({ ok: true, tasks });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.action === 'complete' && body.task_id && body.agent_id) {
      const ok = completeTask(body.task_id, body.agent_id);
      return NextResponse.json({ ok });
    }
    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
