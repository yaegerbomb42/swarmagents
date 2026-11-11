'use client';

const ITEMS = [
  '◆ 7 agents active',
  '◆ blackboard sync 12ms',
  '◆ leaf depth avg 2.4',
  '◆ consensus round 3 ✓',
  '◆ queue depth 14',
  '◆ modal inference warm',
  '◆ file locks 6',
  '◆ repair loop idle',
  '◆ decomp tree 847 nodes',
  '◆ rpm budget 82%',
  '◆ verifier gate pass',
  '◆ agent spawner online',
];

export default function SwarmTelemetryMarquee() {
  const doubled = [...ITEMS, ...ITEMS];

  return (
    <div
      className="relative z-20 w-full overflow-hidden border-y border-cyan-500/10 bg-[#06060e]/80 backdrop-blur-sm"
      aria-hidden
    >
      <div className="absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-[#09090b] to-transparent z-10" />
      <div className="absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[#09090b] to-transparent z-10" />
      <div className="flex animate-marquee-scroll whitespace-nowrap py-2">
        {doubled.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="mx-6 text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-400/50 hover:text-cyan-300/80 transition-colors"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
