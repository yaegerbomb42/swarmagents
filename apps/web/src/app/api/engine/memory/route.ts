import { NextRequest, NextResponse } from 'next/server';
import { getMemoryPersistence } from '@/lib/engine-service';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const persist = getMemoryPersistence();
    await persist.init();
    const state = await persist.loadState();
    return NextResponse.json({ ok: true, state });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const persist = getMemoryPersistence();
    await persist.init();

    if (body.action === 'save' && body.state) {
      await persist.saveState(body.state);
      return NextResponse.json({ ok: true, saved: true });
    }

    if (body.action === 'save_shared' && body.memory) {
      await persist.saveSharedMemory(body.memory);
      return NextResponse.json({ ok: true, saved: true });
    }

    if (body.action === 'load_shared') {
      const memory = await persist.loadSharedMemory();
      return NextResponse.json({ ok: true, memory });
    }

    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
