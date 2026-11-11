import { planned } from '@/lib/planned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Planned post-v1 — engine endpoints for this surface are being retired/rewired.
export async function GET() { return planned('autonomy'); }
export async function POST() { return planned('autonomy'); }
export async function PUT() { return planned('autonomy'); }
export async function PATCH() { return planned('autonomy'); }
export async function DELETE() { return planned('autonomy'); }
