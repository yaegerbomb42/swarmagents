"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FilePreview } from "@/components/FilePreview";

// Full-page viewer for a file from a task: /preview?session=<id>&path=<file>
function Viewer() {
  const q = useSearchParams();
  const session = q.get("session") ?? "";
  const path = q.get("path") ?? "";
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>
      {session && path ? <FilePreview session={session} path={path} full /> : <p className="sub">Nothing to preview.</p>}
    </main>
  );
}

export default function PreviewPage() {
  return (
    <Suspense>
      <Viewer />
    </Suspense>
  );
}
