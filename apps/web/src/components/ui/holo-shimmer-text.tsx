'use client';

import type { ReactNode } from 'react';

export function HoloShimmerText({
  children,
  className = '',
  as: Tag = 'span',
}: {
  children: ReactNode;
  className?: string;
  as?: 'span' | 'h1' | 'h2' | 'p';
}) {
  return (
    <Tag className={`holo-shimmer-text ${className}`}>
      <span className="holo-shimmer-text__inner">{children}</span>
    </Tag>
  );
}
