import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#09090b] text-zinc-100 p-6 text-center">
      <h1 className="text-4xl font-bold text-cyan-400 mb-2">404</h1>
      <h2 className="text-xl font-semibold mb-4">Page Not Found</h2>
      <p className="text-sm text-zinc-400 max-w-md mb-6">
        The requested resource could not be found or has been migrated.
      </p>
      <Link
        href="/"
        className="px-4 py-2 rounded-lg bg-cyan-500 text-black font-semibold text-sm hover:bg-cyan-400 transition"
      >
        Return to Home
      </Link>
    </div>
  );
}
