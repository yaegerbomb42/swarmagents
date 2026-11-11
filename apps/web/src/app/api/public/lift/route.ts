import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import {
  BUNDLED_LANDING_LIFT,
  reportToLandingLift,
  type LandingLiftDemo,
} from '@/lib/landingLiftDemo';
import { loadLatestCapabilityEval } from '@/lib/capabilityEval';

export const runtime = 'nodejs';

async function loadPublicSnapshot(): Promise<LandingLiftDemo | null> {
  try {
    const file = path.join(process.cwd(), 'public', 'demo', 'lift-latest.json');
    const raw = await fs.readFile(file, 'utf8');
    return reportToLandingLift(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Public landing proof — never runs a live eval (cached / bundled only). */
export async function GET() {
  let demo: LandingLiftDemo | null = null;
  try {
    const latest = await loadLatestCapabilityEval();
    if (latest) demo = reportToLandingLift(latest);
  } catch {
    /* ignore */
  }
  if (!demo) demo = await loadPublicSnapshot();
  if (!demo) demo = BUNDLED_LANDING_LIFT;

  return NextResponse.json(
    { ok: true, demo },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    }
  );
}
