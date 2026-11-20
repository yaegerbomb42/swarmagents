import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[#07070a] px-4 text-center text-white antialiased">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">404</p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
        This page doesn&rsquo;t exist.
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-white/50">
        The link may be outdated, the share token invalid, or the page moved.
        Head back to your workspace to keep going.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
      >
        Back to the workspace
      </Link>
    </main>
  );
}
