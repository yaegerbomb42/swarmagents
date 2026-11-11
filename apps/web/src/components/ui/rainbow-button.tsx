'use client';

import React from 'react';

// ════════════════════════════════════════════════════════════
//  RainbowButton — Gradient-animated CTA (MagicUI-style)
// ════════════════════════════════════════════════════════════

export interface RainbowButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  className?: string;
}

export function RainbowButton({ children, className = '', ...props }: RainbowButtonProps) {
  return (
    <button
      {...props}
      className={`
        group relative inline-flex items-center justify-center gap-2
        px-6 py-2.5 cursor-pointer
        rounded-xl
        font-semibold text-white
        bg-[length:200%_100%]
        bg-[linear-gradient(90deg,#ff5757,#ff8a5b,#ffd166,#06d6a0,#26c6da,#a78bfa,#ff5757)]
        animate-[rainbow-shift_3s_linear_infinite]
        shadow-lg shadow-fuchsia-500/30
        hover:shadow-fuchsia-500/50
        hover:scale-[1.02] active:scale-95
        transition-all
        before:absolute before:inset-0 before:rounded-xl
        before:opacity-0 hover:before:opacity-100
        before:bg-gradient-to-r before:from-white/0 before:via-white/20 before:to-white/0
        before:bg-[length:200%_100%]
        before:animate-[shimmer_2s_linear_infinite]
        before:pointer-events-none
        ${className}
      `}
      style={{
        // inline keyframes — Tailwind 4 doesn't always pick up animation in dynamic class
        animation: 'rainbow-shift 3s linear infinite',
      }}
    >
      <style jsx>{`
        @keyframes rainbow-shift {
          0%   { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        @keyframes shimmer {
          0%   { background-position: -200% 50%; }
          100% { background-position: 200% 50%; }
        }
      `}</style>
      <span className="relative z-10 flex items-center gap-2">{children}</span>
    </button>
  );
}

export default RainbowButton;
