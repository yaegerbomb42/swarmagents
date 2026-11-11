/**
 * List / read files in a decomp session workspace (real agent deliverables).
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { hydrateSession, getSession } from '@/lib/decompSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function workspaceRoot(): string {
  return (
    process.env.SWARM_WORKSPACE_ROOT ||
    process.env.ENGINE_WORKSPACE_ROOT ||
    path.join(process.cwd(), '.data', 'workspaces')
  );
}

function resolveWorkspace(session: { id: string; workspace_path?: unknown }): string {
  if (typeof session.workspace_path === 'string' && session.workspace_path) {
    return String(session.workspace_path);
  }
  return path.join(workspaceRoot(), session.id);
}

function safeJoin(root: string, rel: string): string | null {
  const cleaned = rel.replace(/^\/+/, '').replace(/\0/g, '');
  if (cleaned.includes('..')) return null;
  const full = path.resolve(root, cleaned);
  if (!full.startsWith(path.resolve(root))) return null;
  return full;
}

async function listFiles(root: string, max = 80): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix = '') => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      if (ent.name === '.swarm' || ent.name === 'node_modules' || ent.name === '.git') continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), rel);
      else out.push(rel);
    }
  };
  await walk(root);
  return out;
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const filePath = req.nextUrl.searchParams.get('path');
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'missing_sessionId' }, { status: 400 });
  }
  const session = (await hydrateSession(sessionId)) || getSession(sessionId);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
  }
  const root = resolveWorkspace(session);
  try {
    await fs.mkdir(root, { recursive: true });
  } catch {
    /* ignore */
  }

  if (filePath) {
    const full = safeJoin(root, filePath);
    if (!full) {
      return NextResponse.json({ ok: false, error: 'invalid_path' }, { status: 400 });
    }
    try {
      const st = await fs.stat(full);
      if (!st.isFile() || st.size > 200_000) {
        return NextResponse.json({ ok: false, error: 'unreadable' }, { status: 400 });
      }
      const content = await fs.readFile(full, 'utf8');
      return NextResponse.json({
        ok: true,
        workspace: root,
        path: filePath,
        content: content.slice(0, 40_000),
      });
    } catch {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
  }

  const files = await listFiles(root);
  const wantHeat = req.nextUrl.searchParams.get('heatmap') === '1';
  let heatmap: unknown[] = [];
  let blackboard: unknown[] = [];
  if (wantHeat) {
    try {
      const { readBlackboard } = await import('@/lib/sessionBlackboard');
      const { buildCodebaseHeatmap } = await import('@/lib/codebaseHeatmap');
      const { reconcileGateReceipts } = await import('@/lib/sessionExecutor');
      await reconcileGateReceipts(session, root);
      blackboard = await readBlackboard(root, 30);
      heatmap = (await buildCodebaseHeatmap(root, session, blackboard as any)).slice(0, 25);
    } catch {
      /* ignore */
    }
  }
  return NextResponse.json({
    ok: true,
    workspace: root,
    files,
    count: files.length,
    session,
    seats: (session as { seats?: unknown }).seats || [],
    heatmap,
    blackboard: wantHeat ? blackboard.slice(-15) : undefined,
  });
}

/** Save a file the user edited in the workspace IDE. */
export async function PUT(req: NextRequest) {
  let body: { sessionId?: string; path?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const sessionId = String(body.sessionId || '');
  const filePath = String(body.path || '');
  const content = typeof body.content === 'string' ? body.content : null;
  if (!sessionId || !filePath || content === null) {
    return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  }
  if (content.length > 500_000) {
    return NextResponse.json({ ok: false, error: 'too_large' }, { status: 400 });
  }
  const session = (await hydrateSession(sessionId)) || getSession(sessionId);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
  }
  const root = resolveWorkspace(session);
  const full = safeJoin(root, filePath);
  if (!full) {
    return NextResponse.json({ ok: false, error: 'invalid_path' }, { status: 400 });
  }
  try {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    return NextResponse.json({
      ok: true,
      path: filePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      savedAt: Date.now(),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
