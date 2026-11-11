'use client';

import React from 'react';

type ChromaticTextProps = {
  children: string;
  as?: 'span' | 'h1' | 'h2' | 'h3' | 'p';
  className?: string;
};

export default function ChromaticText({
  children,
  as: Tag = 'span',
  className = '',
}: ChromaticTextProps) {
  return (
    <Tag
      className={`hyper-chromatic ${className}`}
      data-text={children}
      data-testid="chromatic-text"
    >
      {children}
    </Tag>
  );
}
