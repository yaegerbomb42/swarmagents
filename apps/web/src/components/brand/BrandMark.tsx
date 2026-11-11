'use client';

export type BrandMarkProps = {
  size?: number;
  className?: string;
  /** Use live WebGL point-cloud field (recommended for ≥64 / hero). */
  dense?: boolean;
  /** Force static SVG even when dense. */
  static?: boolean;
  /** Override typography inside the field (default S). */
  text?: string;
};

/**
 * SwarmAgents mark — live sky/indigo point-cloud field, with SVG fallback.
 */
export default function BrandMark({
  size = 40,
  className = '',
  dense = false,
  static: forceStatic = false,
  text = 'S',
}: BrandMarkProps) {
  const live = !forceStatic && (dense || size >= 28);
  const n = size >= 100 ? 7000 : size >= 64 ? 4500 : 3200;

  if (live) {
    const src = `/brand/mark-embed.html?text=${encodeURIComponent(text)}&n=${n}`;
    return (
      <iframe
        title="SwarmAgents"
        src={src}
        className={`rounded-[22%] border border-white/10 bg-[#09090b] shadow-[0_0_24px_rgba(56,189,248,0.15)] ${className}`}
        style={{
          width: size,
          height: size,
          border: 'none',
          overflow: 'hidden',
          display: 'block',
        }}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/mark.svg"
      alt="SwarmAgents"
      width={size}
      height={size}
      className={`rounded-[22%] ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
