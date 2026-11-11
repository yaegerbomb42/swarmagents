'use client';

import React from 'react';
import DiffViewer from '@/components/DiffViewer';
import FleetDiffReviewPanel from '@/components/diff/FleetDiffReviewPanel';

interface SandboxEditorPaneProps {
  filePath?: string;
  diffLines?: string;
  cursorLine?: number;
  streaming?: boolean;
  sessionId?: string | null;
  liveStream?: boolean;
  /** Fleet patch review uses side-by-side StreamingDiffGutter. */
  fleetReview?: boolean;
}

export default function SandboxEditorPane({
  filePath,
  diffLines = '',
  streaming = true,
  sessionId = null,
  liveStream = false,
  fleetReview = false,
}: SandboxEditorPaneProps) {
  const filename = filePath || '—';
  if (fleetReview) {
    return (
      <FleetDiffReviewPanel
        filename={filename}
        diffText={diffLines}
        liveStream={liveStream}
        sessionId={sessionId}
        className="h-full rounded-none border-0"
      />
    );
  }

  if (!liveStream && !diffLines.trim()) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0c0c0c] p-6 text-center text-[11px] text-[var(--fg-3)]">
        No file changes reported by this agent yet.
      </div>
    );
  }

  return (
    <DiffViewer
      filename={filename}
      diffText={diffLines}
      streaming={streaming && !liveStream}
      liveStream={liveStream}
      sessionId={sessionId}
      className="h-full rounded-none border-0"
    />
  );
}
