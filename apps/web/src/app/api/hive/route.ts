import { planned } from '@/lib/planned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Planned post-v1 — engine endpoints for this surface are being retired/rewired.
export async function GET() { return planned('hive'); }
export async function POST() { return planned('hive'); }
export async function PUT() { return planned('hive'); }
export async function PATCH() { return planned('hive'); }
export async function DELETE() { return planned('hive'); }
