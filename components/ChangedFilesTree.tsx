"use client";

import { useState, useMemo } from "react";
import type { AgentEvent } from "@/lib/types";
import { IFile, IChevron } from "./icons";
import { PreviewChip, producedFiles } from "./FilePreview";

interface ChangedFilesTreeProps {
  events: AgentEvent[];
  session?: string;
}

interface ChangedFile {
  path: string;
  kind: "created" | "edited" | "produced";
  count: number;
}

export function ChangedFilesTree({ events, session }: ChangedFilesTreeProps) {
  const [open, setOpen] = useState(false);

  const files = useMemo(() => {
    const map = new Map<string, ChangedFile>();

    for (const e of events) {
      if (e.type !== "tool") continue;

      const input = (e.input ?? {}) as Record<string, unknown>;
      if (typeof input.path === "string" && input.path) {
        const p = input.path;
        const current = map.get(p);
        if (e.name === "write_file") {
          map.set(p, { path: p, kind: current?.kind === "edited" ? "edited" : "created", count: (current?.count ?? 0) + 1 });
        } else if (e.name === "edit_file") {
          map.set(p, { path: p, kind: "edited", count: (current?.count ?? 0) + 1 });
        }
      }

      if (e.output) {
        const produced = producedFiles(e.output);
        for (const p of produced) {
          if (!map.has(p)) {
            map.set(p, { path: p, kind: "produced", count: 1 });
          }
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [events]);

  if (!files.length) return null;

  return (
    <div className="changed-files-tree">
      <button className="changed-files-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <IFile />
        <span className="changed-files-title">
          Changed Files ({files.length})
        </span>
        <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
          <IChevron />
        </span>
      </button>

      {open && (
        <div className="changed-files-list">
          {files.map((f) => {
            const parts = f.path.split("/");
            const name = parts[parts.length - 1];
            const dir = parts.slice(0, -1).join("/");

            return (
              <div key={f.path} className="changed-file-row">
                <span className={`changed-file-badge ${f.kind}`}>
                  {f.kind === "created" ? "+" : f.kind === "edited" ? "M" : "↓"}
                </span>
                <span className="changed-file-path" title={f.path}>
                  {dir ? <span className="changed-file-dir">{dir}/</span> : null}
                  <span className="changed-file-name">{name}</span>
                </span>
                {session && (
                  <div className="changed-file-actions">
                    <PreviewChip session={session} path={f.path} label="View" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
