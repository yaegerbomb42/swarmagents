import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WaitlistEntry = {
  email: string;
  name?: string;
  plan?: string;
  createdAt: string;
  source?: string;
};

function storePath() {
  return path.join(process.cwd(), '.data', 'waitlist.jsonl');
}

export async function POST(req: NextRequest) {
  let body: { email?: string; name?: string; plan?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const email = String(body.email || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid_email' }, { status: 400 });
  }

  const entry: WaitlistEntry = {
    email,
    name: body.name ? String(body.name).trim().slice(0, 120) : undefined,
    plan: body.plan ? String(body.plan).trim().slice(0, 40) : 'pro',
    source: body.source ? String(body.source).trim().slice(0, 80) : 'billing',
    createdAt: new Date().toISOString(),
  };

  const file = storePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');

  return NextResponse.json({ ok: true, queued: true });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    plans: [
      {
        id: 'beta',
        name: 'Beta',
        price: '$0',
        blurb: 'BYOK + hosted DeepSeek flash quota while slots last',
        cta: 'Start free',
        href: '/signup?next=/decomp',
      },
      {
        id: 'pro',
        name: 'Pro',
        price: 'Waitlist',
        blurb: 'Higher concurrency, priority routing, shared team agents',
        cta: 'Join waitlist',
        href: '/billing#waitlist',
      },
    ],
  });
}
