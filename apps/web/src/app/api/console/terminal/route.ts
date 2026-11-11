import { NextRequest, NextResponse } from 'next/server';

const ALLOWED = new Set(['echo', 'pwd', 'date', 'env']);

/**
 * Safe read-only console proxy for dashboard agent terminal.
 * Shell execution is intentionally restricted; extend via engine bridge when wired.
 */
export async function POST(req: NextRequest) {
  let body: { command?: string; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const command = (body.command ?? '').trim();
  if (!command) {
    return NextResponse.json({ error: 'empty command' }, { status: 400 });
  }

  const [name, ...args] = command.split(/\s+/);
  const head = name.toLowerCase();

  if (!ALLOWED.has(head)) {
    return NextResponse.json(
      {
        error: `command not allowed: ${head}. Allowed: ${[...ALLOWED].join(', ')}`,
      },
      { status: 403 }
    );
  }

  switch (head) {
    case 'echo':
      return NextResponse.json({ output: args.join(' ') });
    case 'pwd':
      return NextResponse.json({ output: process.cwd() });
    case 'date':
      return NextResponse.json({ output: new Date().toISOString() });
    case 'env':
      return NextResponse.json({
        output: `NODE_ENV=${process.env.NODE_ENV ?? 'development'}\nSESSION=${body.sessionId ?? 'none'}`,
      });
    default:
      return NextResponse.json({ error: 'unhandled' }, { status: 500 });
  }
}
