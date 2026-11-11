'use client';

import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import ConsoleShell from '@/components/ConsoleShell';
import RequireAuth from '@/components/auth/RequireAuth';

const SwarmCommandCenter = dynamic(
  () => import('@/components/launch/SwarmCommandCenter'),
  { ssr: false },
);

export default function CommandPage() {
  return (
    <RequireAuth>
      <ConsoleShell>
        <main className="flex-1 min-h-0 p-3 md:p-4 overflow-y-auto">
          <Suspense
            fallback={
              <div className="p-12 text-center text-sm text-zinc-500">
                Initializing mission command…
              </div>
            }
          >
            <SwarmCommandCenter />
          </Suspense>
        </main>
      </ConsoleShell>
    </RequireAuth>
  );
}
