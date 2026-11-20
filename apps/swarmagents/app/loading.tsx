export default function Loading() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[#07070a] px-4 text-center text-white antialiased">
      <div
        aria-hidden
        className="h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-white/70"
      />
      <p className="mt-5 text-sm text-white/50">Loading&hellip;</p>
    </main>
  );
}
