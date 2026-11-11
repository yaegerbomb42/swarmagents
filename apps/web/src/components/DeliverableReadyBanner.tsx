"use client";

import { Download, FolderOpen, Sparkles } from "lucide-react";
import { authHeaders } from "@/lib/auth";

type Props = {
  sessionId: string;
  files: string[];
  onOpenFile: (path: string) => void;
};

function pickPrimaryDeliverable(files: string[]): string | null {
  const deliverables = files.filter((f) => f.startsWith("deliverables/"));
  if (deliverables.includes("deliverables/README.md")) return "deliverables/README.md";
  if (deliverables.length) return deliverables[0];
  const src = files.find((f) => f.startsWith("src/") && !f.endsWith(".map"));
  if (src) return src;
  const html = files.find((f) => f.endsWith(".html"));
  if (html) return html;
  return files.find((f) => !f.endsWith("README.md")) || files[0] || null;
}

export default function DeliverableReadyBanner({ sessionId, files, onOpenFile }: Props) {
  if (!files.length) return null;

  const primary = pickPrimaryDeliverable(files);

  const downloadPrimary = async () => {
    if (!primary) return;
    const res = await fetch(
      `/api/tasks/workspace?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(primary)}`,
      { headers: authHeaders() }
    );
    const data = await res.json();
    if (!data.ok || typeof data.content !== "string") return;
    const blob = new Blob([data.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = primary.split("/").pop() || "deliverable.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-3 mt-3 shrink-0 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2.5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <Sparkles className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-emerald-100">Deliverable ready</p>
          <p className="text-[11px] text-emerald-200/60 truncate">
            {files.length} file{files.length === 1 ? "" : "s"} in workspace
            {primary ? ` · ${primary}` : ""}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {primary ? (
          <>
            <button
              type="button"
              onClick={() => onOpenFile(primary)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] border border-emerald-500/30 text-emerald-100 hover:bg-emerald-500/10"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Open
            </button>
            <button
              type="button"
              onClick={() => void downloadPrimary()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] bg-emerald-500 text-black font-medium hover:bg-emerald-400"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
