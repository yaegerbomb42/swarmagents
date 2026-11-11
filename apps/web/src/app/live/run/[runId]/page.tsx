'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import RequireAuth from '@/components/auth/RequireAuth';
import Cockpit from '@/components/cockpit/Cockpit';

function CockpitRoute() {
  const params = useParams<{ runId: string }>();
  const search = useSearchParams();
  const runId = decodeURIComponent(String(params?.runId ?? ''));
  const mode = search?.get('mode') === 'replay' ? 'replay' : 'live';
  return runId ? <Cockpit key={runId} runId={runId} initialMode={mode} /> : null;
}

export default function RunCockpitPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <CockpitRoute />
      </Suspense>
    </RequireAuth>
  );
}
