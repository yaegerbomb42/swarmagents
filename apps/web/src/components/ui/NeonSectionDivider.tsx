'use client';

/** Animated gradient beam divider between sections */
export default function NeonSectionDivider({ className = '' }: { className?: string }) {
  return (
    <div className={`neon-divider relative h-px w-full max-w-5xl mx-auto ${className}`} aria-hidden>
      <div className="neon-divider__beam absolute inset-0" />
      <div className="neon-divider__glow absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-8" />
    </div>
  );
}
