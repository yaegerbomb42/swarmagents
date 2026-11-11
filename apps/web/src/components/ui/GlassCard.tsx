'use client';

import React from 'react';

export type GlassCardVariant = 'cyan' | 'purple' | 'magenta';

export type GlassCardProps = {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  footer?: React.ReactNode;
  variant?: GlassCardVariant;
  interactive?: boolean;
  pulse?: boolean;
  shimmer?: boolean;
  className?: string;
  'data-testid'?: string;
};

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export default function GlassCard({
  children,
  title,
  subtitle,
  footer,
  variant = 'cyan',
  interactive = true,
  pulse = false,
  shimmer = false,
  className,
  'data-testid': testId = 'glass-card',
}: GlassCardProps) {
  return (
    <article
      data-testid={testId}
      role="region"
      aria-label={title ?? 'Glass card'}
      tabIndex={interactive ? 0 : undefined}
      className={cx(
        'glass-card',
        `glass-card--${variant}`,
        interactive && 'glass-card--interactive',
        pulse && 'glass-card--pulse',
        className,
      )}
    >
      <div className="glass-card__glow" aria-hidden />
      <div className="glass-card__scanline" aria-hidden />
      {shimmer ? <div className="glass-card__shimmer" aria-hidden /> : null}
      {(title || subtitle) && (
        <header className="glass-card__header">
          {subtitle ? <p className="glass-card__subtitle">{subtitle}</p> : null}
          {title ? <h3 className="glass-card__title">{title}</h3> : null}
        </header>
      )}
      <div className="glass-card__body">{children}</div>
      {footer ? <footer className="glass-card__footer">{footer}</footer> : null}
    </article>
  );
}
