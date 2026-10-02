/**
 * SwarmAgents Design System Tokens
 * Single source of truth for all visual values.
 * Used as CSS custom properties in globals.css and as TS constants in components.
 */

export const tokens = {
  // ── Color ──
  // Pure black canvas, white neon lines with soft glow
  color: {
    // Canvas
    bg: "#000000",
    bgElevated: "#0a0a0a",
    bgSunken: "#050505",

    // Lines / borders
    line: "#1a1a1a",
    lineStrong: "#2a2a2a",
    lineGlow: "#3a3a3a",

    // Text
    text: "#ffffff",
    textMuted: "#888888",
    textFaint: "#555555",
    textInverted: "#000000",

    // Accents (restrained, semantic)
    accent: "#ffffff",
    accentText: "#000000",
    accentMuted: "#444444",

    // Semantic
    ok: "#22c55e",
    okGlow: "rgba(34, 197, 94, 0.4)",
    warn: "#fbbf24",
    warnGlow: "rgba(251, 191, 36, 0.4)",
    err: "#ef4444",
    errGlow: "rgba(239, 68, 68, 0.4)",
    run: "#3b82f6",
    runGlow: "rgba(59, 130, 246, 0.4)",

    // Neon glow colors (for hexagon, ambient)
    neon: "#ffffff",
    neonSoft: "rgba(255, 255, 255, 0.15)",
    neonMed: "rgba(255, 255, 255, 0.3)",
    neonStrong: "rgba(255, 255, 255, 0.6)",

    // Code
    codeBg: "#080808",
    codeLine: "#1a1a1a",
  },

  // ── Spacing ──
  // Base unit: 4px. Scale: 0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64
  space: {
    0: "0",
    1: "4px",
    2: "8px",
    3: "12px",
    4: "16px",
    5: "20px",
    6: "24px",
    8: "32px",
    10: "40px",
    12: "48px",
    16: "64px",
    20: "80px",
    24: "96px",
  },

  // ── Typography ──
  // One great sans (Geist/SF Pro), one mono (Geist Mono/JetBrains Mono)
  type: {
    sans: '"Geist", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono: '"Geist Mono", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  },
} as const;

export type Tokens = typeof tokens;
export type SpaceKey = keyof typeof tokens.space;
export type ColorKey = keyof typeof tokens.color;
export type RadiusKey = keyof typeof tokens.radius;
export type SizeKey = keyof typeof tokens.type.size;
export type DurationKey = keyof typeof tokens.motion.duration;
export type EasingKey = keyof typeof tokens.motion.easing;
export type ElevationKey = keyof typeof tokens.elevation;
export type BreakpointKey = keyof typeof tokens.breakpoint;
export type ZIndexKey = keyof typeof tokens.zIndex;