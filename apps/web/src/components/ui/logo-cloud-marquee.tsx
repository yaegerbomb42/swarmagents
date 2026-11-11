'use client';

import React from 'react';
import Marquee from 'react-fast-marquee';

// ════════════════════════════════════════════════════════════
//  LogoCloudMarquee — Scrolling provider/integration logos
// ════════════════════════════════════════════════════════════

export interface LogoCloudItem {
  name: string;
  src?: string;     // optional logo URL
  icon?: React.ReactNode;
}

export interface LogoCloudMarqueeProps {
  items: LogoCloudItem[];
  speed?: number;
  direction?: 'left' | 'right';
  pauseOnHover?: boolean;
  className?: string;
  itemClassName?: string;
}

export function LogoCloudMarquee({
  items,
  speed = 40,
  direction = 'left',
  pauseOnHover = true,
  className = '',
  itemClassName = '',
}: LogoCloudMarqueeProps) {
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Gradient edge fades */}
      <div className="absolute left-0 top-0 bottom-0 w-16 bg-gradient-to-r from-[#050508] to-transparent z-10 pointer-events-none" />
      <div className="absolute right-0 top-0 bottom-0 w-16 bg-gradient-to-l from-[#050508] to-transparent z-10 pointer-events-none" />

      <Marquee speed={speed} direction={direction} pauseOnHover={pauseOnHover} gradient={false}>
        {items.map((it, i) => (
          <div
            key={`${it.name}-${i}`}
            className={`flex items-center gap-3 px-8 py-4 text-gray-400 hover:text-white transition-colors ${itemClassName}`}
          >
            {it.src ? (
              <img src={it.src} alt={it.name} className="h-7 w-7 object-contain opacity-60 hover:opacity-100" />
            ) : it.icon ? (
              <span className="opacity-70">{it.icon}</span>
            ) : null}
            <span className="text-sm font-medium tracking-wide whitespace-nowrap">{it.name}</span>
          </div>
        ))}
      </Marquee>
    </div>
  );
}

export default LogoCloudMarquee;
