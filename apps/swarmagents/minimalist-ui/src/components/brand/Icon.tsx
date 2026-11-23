"use client";

/**
 * Icon — renders one of the 13 hand-authored brand icons from the sprite
 * (apps/swarmagents/public/brand/icons/sprite.svg, PR #181).
 *
 * Icons are 24px-grid, stroke="currentColor" stroke-width 1.8 — color them
 * with CSS `color` (Tailwind text-*), size with `size` or width/height.
 * Decorative by default (aria-hidden); pass `label` when the icon is the
 * only content of a control and carries meaning on its own.
 */

import type { SVGProps } from "react";
import { ICON_SPRITE_HREF, type IconName } from "./tokens";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Pixel size (width = height). Default 18. */
  size?: number;
  /** Accessible name. Omit for decorative icons. */
  label?: string;
  /** Sprite URL override (e.g. when served from a different base path). */
  spriteHref?: string;
}

export function Icon({
  name,
  size = 18,
  label,
  spriteHref = ICON_SPRITE_HREF,
  className,
  ...rest
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      <use href={`${spriteHref}#icon-${name}`} />
    </svg>
  );
}
