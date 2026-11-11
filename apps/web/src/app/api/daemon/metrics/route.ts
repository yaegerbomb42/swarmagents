import { planned } from '@/lib/planned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Planned post-v1 — engine endpoints for this surface are being retired/rewired.
export async function GET() { return planned('daemon-metrics'); }
export async function POST() { return planned('daemon-metrics'); }
export async function PUT() { return planned('daemon-metrics'); }
export async function PATCH() { return planned('daemon-metrics'); }
export async function DELETE() { return planned('daemon-metrics'); }
