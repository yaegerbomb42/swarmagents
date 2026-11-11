import { NextResponse } from 'next/server';

/**
 * Uniform 501 response for routes that are planned but not shipped in v1.
 * Header `X-Planned: true` lets smoke tests and clients detect planned routes.
 */
export function planned(feature: string): NextResponse {
  return NextResponse.json(
    { error: 'not_implemented', planned: true, feature },
    { status: 501, headers: { 'X-Planned': 'true' } }
  );
}
