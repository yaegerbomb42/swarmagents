/**
 * tokens.ts — JS mirror of the brand design tokens (see tokens.css).
 *
 * Pure data, no DOM: safe to import anywhere, unit-tested in tokens.test.ts.
 * Color values come from apps/swarmagents/branding/BRAND.md (PR #181); the
 * CSS file is the styling source of truth — keep the two in sync.
 */

export const BRAND_COLORS = {
  voidNavy: "#13192C",
  ink: "#0B1020",
  signalCyan: "#00D0F0",
  deepSignal: "#005080",
  paper: "#FFFFFF",
  mist: "#B4BED2",
} as const;

export type BrandColor = keyof typeof BRAND_COLORS;

/** Status hues — status only, never brand meaning. */
export const STATUS_COLORS = {
  ok: "#34D399",
  warn: "#FBBF24",
  err: "#FB7185",
} as const;

/** Motion timings in ms (mirror of --brand-motion-* in tokens.css). */
export const BRAND_MOTION_MS = {
  fast: 120,
  base: 180,
  slow: 320,
} as const;

/** Spacing scale in px (4px base; mirror of --brand-space-*). */
export const BRAND_SPACING = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

/**
 * The 13 hand-authored brand icons (apps/swarmagents/public/brand/icons/),
 * 24px grid, stroke currentColor 1.8. Rendered via the sprite — see Icon.tsx.
 */
export const ICON_NAMES = [
  "chat-bar",
  "vm-screen",
  "takeover",
  "shield",
  "key",
  "play",
  "stop",
  "settings",
  "terminal",
  "file",
  "browser",
  "check",
  "warning",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Default sprite location (served from the app's public dir). */
export const ICON_SPRITE_HREF = "/brand/icons/sprite.svg";
