'use client';

import { useEffect, useState } from 'react';

export default function LiveSystemClock({ className = '' }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!now) return null;

  const utc = now.toISOString().slice(11, 19);
  const local = now.toLocaleTimeString(undefined, { hour12: false });

  return (
    <span className={`font-mono text-[10px] tracking-wider text-cyan-500/40 tabular-nums ${className}`}>
      SYS {utc}Z · LOCAL {local}
    </span>
  );
}
