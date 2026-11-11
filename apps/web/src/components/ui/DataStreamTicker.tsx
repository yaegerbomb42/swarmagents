'use client';

import React, { useMemo } from 'react';

type DataStreamTickerProps = {
  className?: string;
  speed?: 'slow' | 'normal' | 'fast';
};

function generateSegment(): string {
  const hex = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16).toUpperCase(),
  ).join('');
  const tags = ['SWARM', 'NODE', 'SYNC', 'HASH', 'ROUTE', 'FLEET', 'AGENT', 'TASK'];
  const tag = tags[Math.floor(Math.random() * tags.length)];
  return `${tag}::0x${hex}`;
}

export default function DataStreamTicker({
  className = '',
  speed = 'normal',
}: DataStreamTickerProps) {
  const segments = useMemo(() => {
    const items = Array.from({ length: 24 }, () => generateSegment());
    return [...items, ...items];
  }, []);

  const duration =
    speed === 'slow' ? '60s' : speed === 'fast' ? '25s' : '40s';

  return (
    <div
      className={`hyper-data-stream ${className}`}
      aria-hidden
      data-testid="data-stream-ticker"
    >
      <div
        className="hyper-data-stream__track"
        style={{ animationDuration: duration }}
      >
        {segments.map((seg, i) => (
          <span
            key={`${seg}-${i}`}
            className={
              i % 5 === 0
                ? 'hyper-data-stream__segment hyper-data-stream__highlight'
                : 'hyper-data-stream__segment'
            }
          >
            {seg}
          </span>
        ))}
      </div>
    </div>
  );
}
