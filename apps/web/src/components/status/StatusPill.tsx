'use client';

import StatusDot from './StatusDot';
import { statusMeta, type CanonicalStatus } from '@/lib/status';

export interface StatusPillProps {
  status: CanonicalStatus | string | null | undefined;
  /** Override the canonical label (e.g. "3 running"). */
  label?: string;
  animate?: boolean;
  className?: string;
}

export default function StatusPill({ status, label, animate = true, className = '' }: StatusPillProps) {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] leading-4 ${className}`}
      style={{
        color: meta.colorVar,
        borderColor: `color-mix(in srgb, ${meta.colorVar} 30%, transparent)`,
        background: `color-mix(in srgb, ${meta.colorVar} 8%, transparent)`,
      }}
    >
      <StatusDot status={meta.status} size={7} animate={animate} />
      <span>{label ?? meta.label}</span>
      {meta.status === 'failed' && !label && <span aria-hidden>!</span>}
    </span>
  );
}
