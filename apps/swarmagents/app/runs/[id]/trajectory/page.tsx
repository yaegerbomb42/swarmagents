import React from "react";
import Link from "next/link";
import { TrajectoryViewer } from "../../../../minimalist-ui/src/components/TrajectoryViewer";

export const dynamic = "force-dynamic";

export default async function TrajectoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="min-h-dvh bg-[#07070a] px-4 py-8 text-white antialiased sm:px-8">
      <div className="mx-auto max-w-5xl">
        <Link href="/" className="text-sm text-cyan-200 hover:text-cyan-100">← Back to SwarmAgents</Link>
        <header className="mb-6 mt-6">
          <h1 className="text-2xl font-semibold tracking-tight">Run replay</h1>
          <p className="mt-1 font-mono text-xs text-zinc-500">{id}</p>
        </header>
        <TrajectoryViewer runId={id} />
      </div>
    </main>
  );
}
