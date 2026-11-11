'use client';

import Link from 'next/link';
import { Zap } from 'lucide-react';
import Wordmark from '@/components/brand/Wordmark';
import ConsoleNav from '@/components/ConsoleNav';
import { UniversalLauncherPill } from '@/components/CommandPalette';
import { useBalance } from '@/hooks/useBalance';

type GlassHeaderProps = {
  missionHint?: string;
  trailing?: React.ReactNode;
};

export default function GlassHeader({
  missionHint,
  trailing,
}: GlassHeaderProps) {
  const { balance } = useBalance({ intervalMs: 30_000 });

  return (
    <header
      className="h-12 shrink-0 z-50 border-b border-line-1 bg-bg-1"
    >
      <div className="h-full max-w-[1800px] mx-auto px-3 sm:px-4 grid grid-cols-[minmax(6rem,1fr)_auto_minmax(6rem,1fr)] items-center gap-2 sm:gap-3">
        <div className="flex items-center gap-2 min-w-0 justify-self-start">
          <Wordmark size={22} textClassName="text-body font-semibold tracking-tight font-mono" />
          {missionHint ? (
            <span
              className="hidden lg:block text-meta text-fg-3 truncate max-w-[14rem] border-l border-line-2 pl-2.5"
              title={missionHint}
            >
              {missionHint}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <ConsoleNav dense />
          <UniversalLauncherPill className="hidden xl:flex ml-2" />
        </div>

        <div className="flex items-center gap-2 sm:gap-3 justify-self-end min-w-0 flex-wrap justify-end">
          {balance ? (
            <Link
              href="/billing"
              className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-meta font-mono tabular-nums text-fg-3 hover:text-fg-1 whitespace-nowrap rounded-r-sm hover:bg-white/[0.04]"
              title="Credits"
            >
              <Zap size={11} className="text-amber-400/80" />
              {balance.credits.toFixed(1)} cr
            </Link>
          ) : null}

          {trailing}
        </div>
      </div>
    </header>
  );
}
