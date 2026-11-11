'use client';

import React from 'react';

type AuroraMeshProps = {
  className?: string;
  showGrain?: boolean;
  showHex?: boolean;
};

export default function AuroraMesh({
  className = '',
  showGrain = true,
  showHex = false,
}: AuroraMeshProps) {
  return (
    <div className={`hyper-aurora ${className}`} aria-hidden>
      <div className="hyper-aurora__blob hyper-aurora__blob--1" />
      <div className="hyper-aurora__blob hyper-aurora__blob--2" />
      <div className="hyper-aurora__blob hyper-aurora__blob--3" />
      {showHex ? <div className="hyper-hex-grid" /> : null}
      {showGrain ? <div className="hyper-grain" /> : null}
    </div>
  );
}
