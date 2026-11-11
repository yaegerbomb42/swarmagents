'use client';

import Link from 'next/link';
import BrandMark from './BrandMark';

export type WordmarkProps = {
  size?: number;
  href?: string;
  className?: string;
  textClassName?: string;
};

/**
 * Unified SwarmAgents brand lockup: the BrandMark icon + "swarmagents.codes"
 * wordmark, identical across every page (landing header/footer, site header,
 * console header, footer).
 */
export default function Wordmark({
  size = 26,
  href = '/',
  className = '',
  textClassName = 'text-[15px] font-semibold tracking-[-0.03em] font-mono',
}: WordmarkProps) {
  return (
    <Link href={href} className={`group flex items-center gap-2 w-fit transition-transform duration-150 hover:-translate-y-px ${className}`}>
      <BrandMark size={size} />
      <span className={`${textClassName} text-[#fafafa] group-hover:text-white transition-colors`}>
        swarmagents.codes
      </span>
    </Link>
  );
}
