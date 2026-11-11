'use client';

import StreamingDiffGutter from '@/components/diff/StreamingDiffGutter';

export type FleetDiffReviewPanelProps = {
  filename: string;
  diffText?: string;
  sessionId?: string | null;
  liveStream?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  className?: string;
};

/** Fleet patch review — side-by-side gutter diff with approve/reject actions. */
export default function FleetDiffReviewPanel({
  filename,
  diffText = '',
  sessionId = null,
  liveStream = false,
  onApprove,
  onReject,
  className = '',
}: FleetDiffReviewPanelProps) {
  const hasPatch = liveStream || Boolean(diffText.trim());

  if (!hasPatch) {
    return (
      <div
        data-testid="fleet-diff-review-empty"
        className={`flex h-full min-h-[12rem] items-center justify-center rounded-xl border border-dashed border-white/10 bg-[#06061a]/60 px-4 text-center ${className}`}
      >
        <p className="text-xs text-zinc-500">No fleet patch queued for review</p>
      </div>
    );
  }

  return (
    <StreamingDiffGutter
      filename={filename}
      diffText={diffText}
      sessionId={sessionId}
      liveStream={liveStream}
      onApprove={onApprove}
      onReject={onReject}
      className={className}
    />
  );
}
