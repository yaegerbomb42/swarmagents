'use client';

import Link from 'next/link';

export interface PaywallPromptProps {
  variant?: 'modal' | 'inline';
  creditsRequired?: number;
  creditsAvailable?: number;
  onDismiss?: () => void;
}

/**
 * PaywallPrompt — exported for TASK-02 (execution components) to render on
 * engine 402 / `insufficient_credits` responses.
 *
 * Usage:
 *   if (res.status === 402) return <PaywallPrompt creditsRequired={...} creditsAvailable={...} />;
 */
export default function PaywallPrompt({
  variant = 'inline',
  creditsRequired,
  creditsAvailable,
  onDismiss,
}: PaywallPromptProps) {
  const content = (
    <div className="border border-amber-500/40 bg-amber-500/10 text-amber-200 rounded-lg p-4">
      <h3 className="font-semibold text-amber-100 mb-1">Insufficient credits</h3>
      <p className="text-sm text-amber-200/80 mb-3">
        {creditsRequired != null && creditsAvailable != null
          ? `This call needs ${creditsRequired.toFixed(3)} cr but you have ${creditsAvailable.toFixed(3)} cr.`
          : 'You\u2019re out of credits. Upgrade to keep the swarm running.'}
      </p>
      <div className="flex gap-2">
        <Link
          href="/pricing"
          className="px-3 py-1.5 text-sm rounded bg-amber-500 text-black font-medium hover:bg-amber-400"
        >
          View plans
        </Link>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-sm rounded border border-amber-500/30 text-amber-200 hover:bg-amber-500/5"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );

  if (variant === 'modal') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="max-w-md w-full">{content}</div>
      </div>
    );
  }
  return content;
}
