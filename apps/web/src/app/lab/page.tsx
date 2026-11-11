"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import ConsoleShell from "@/components/ConsoleShell";
import RequireAuth from "@/components/auth/RequireAuth";

const SwarmLabMaster = dynamic(() => import("@/components/lab/SwarmLabMaster"), { ssr: false });

export default function DedicatedLabPage() {
  return (
    <RequireAuth>
      <ConsoleShell>
        <main className="flex-1 min-h-0 flex flex-col">
          <Suspense fallback={<div className="p-8 text-sm text-zinc-500">Loading SwarmAgents Lab…</div>}>
            <SwarmLabMaster />
          </Suspense>
        </main>
      </ConsoleShell>
    </RequireAuth>
  );
}
