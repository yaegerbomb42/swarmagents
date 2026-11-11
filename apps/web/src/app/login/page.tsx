'use client';

import { Suspense } from 'react';
import LoginInner from './LoginInner';

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#020204] text-white/40 flex items-center justify-center text-sm">
          Loading…
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
