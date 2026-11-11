import { planned } from '@/lib/planned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Planned post-v1 — generic topology stream not shipped in this release.
export async function GET() { return planned('v1-state'); }
export async function POST() { return planned('v1-state'); }
