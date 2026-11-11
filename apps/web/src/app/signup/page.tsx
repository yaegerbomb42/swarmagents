'use client';

import { Suspense } from 'react';
import SignupInner from './SignupInner';

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#020204] text-white/40 flex items-center justify-center text-sm">
          Loading…
        </div>
      }
    >
      <SignupInner />
    </Suspense>
  );
}
