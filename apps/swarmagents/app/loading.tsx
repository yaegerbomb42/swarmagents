export default function Loading() {
  return (
    <main
      aria-busy="true"
      className="flex min-h-dvh flex-col items-center justify-center bg-[#07070a] px-4 text-center text-white antialiased"
    >
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">SwarmAgents</p>
      <div
        aria-hidden
        className="mt-6 h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-white/70"
      />
      <p role="status" className="mt-5 text-sm text-white/50">
        Loading your workspace&hellip;
      </p>
    </main>
  );
}
