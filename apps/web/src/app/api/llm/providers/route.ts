import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

export async function GET() {
  try {
    const res = await fetch(`${ENGINE_URL}/llm/providers`, { cache: 'no-store' });
    if (res.ok) return NextResponse.json(await res.json());
  } catch {}
  return NextResponse.json({ providers: [], note: 'LLM provider manager not available' });
}