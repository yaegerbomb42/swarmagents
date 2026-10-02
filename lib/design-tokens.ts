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

    // Fluid type scale (clamp for responsive)
    // Step -1: 12px → 13px
    // Step 0: 14px → 15px (base)
    // Step 1: 16px → 17px
    // Step 2: 18px → 20px
    // Step 3: 22px → 25px
    // Step 4: 28px → 32px
    // Step 5: 36px → 42px
    // Step 6: 48px → 56px
    size: {
      "-1": "clamp(0.75rem, 0.72rem + 0.15vw, 0.8125rem)", // 12-13px
      "0": "clamp(0.875rem, 0.84rem + 0.18vw, 0.9375rem)", // 14-15px
      "1": "clamp(1rem, 0.96rem + 0.2vw, 1.0625rem)", // 16-17px
      "2": "clamp(1.125rem, 1.07rem + 0.28vw, 1.25rem)", // 18-20px
      "3": "clamp(1.375rem, 1.3rem + 0.38vw, 1.5625rem)", // 22-25px
      "4": "clamp(1.75rem, 1.64rem + 0.55vw, 2rem)", // 28-32px
      "5": "clamp(2.25rem, 2.08rem + 0.85vw, 2.625rem)", // 36-42px
      "6": "clamp(3rem, 2.75rem + 1.25vw, 3.5rem)", // 48-56px
    },

    weight: {
      regular: "400",
      medium: "500",
      semibold: "600",
      bold: "700",
    },

    lineHeight: {
      tight: "1.2",
      normal: "1.5",
      relaxed: "1.7",
      code: "1.6",
    },

    letterSpacing: {
      tight: "-0.02em",
      normal: "0",
      wide: "0.02em",
      wider: "0.06em",
    },
  },

  // ── Radius ──
  radius: {
    none: "0",
    xs: "4px",
    sm: "6px",
    md: "8px",
    lg: "12px",
    xl: "16px",
    "2xl": "24px",
    full: "9999px",
  },

  // ── Elevation / Glow ──
  // Neon-on-black elevation system
  elevation: {
    // Box shadows (layered for depth)
    0: "none",
    1: "0 1px 2px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--line)",
    2: "0 2px 8px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line)",
    3: "0 4px 16px rgba(0, 0, 0, 0.7), 0 0 0 1px var(--line)",
    4: "0 8px 32px rgba(0, 0, 0, 0.8), 0 0 0 1px var(--line)",

    // Neon glow shadows (for active/focused states)
    glowSm: "0 0 8px var(--neon-soft), 0 0 16px var(--neon-soft)",
    glowMd: "0 0 16px var(--neon-med), 0 0 32px var(--neon-med)",
    glowLg: "0 0 24px var(--neon-strong), 0 0 48px var(--neon-strong)",
    glowXl: "0 0 32px var(--neon-strong), 0 0 64px var(--neon-strong)",

    // Colored glows for semantic states
    glowOk: "0 0 16px var(--ok-glow), 0 0 32px var(--ok-glow)",
    glowWarn: "0 0 16px var(--warn-glow), 0 0 32px var(--warn-glow)",
    glowErr: "0 0 16px var(--err-glow), 0 0 32px var(--err-glow)",
    glowRun: "0 0 16px var(--run-glow), 0 0 32px var(--run-glow)",
  },

  // ── Motion ──
  motion: {
    // Durations
    duration: {
      instant: "0ms",
      fast: "80ms",
      normal: "150ms",
      slow: "250ms",
      slower: "400ms",
      slowest: "600ms",
    },

    // Easings
    easing: {
      linear: "linear",
      easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
      easeIn: "cubic-bezier(0.7, 0, 0.84, 0)",
      easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)",
      spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      springGentle: "cubic-bezier(0.25, 1, 0.5, 1)",
    },

    // Reduced motion overrides
    reduced: {
      duration: "0.01ms",
      easing: "linear",
    },
  },

  // ── Breakpoints ──
  breakpoint: {
    sm: "375px",
    md: "768px",
    lg: "1024px",
    xl: "1440px",
    "2xl": "1920px",
  },

  // ── Z-index ──
  zIndex: {
    base: 0,
    dropdown: 10,
    sticky: 20,
    modal: 30,
    popover: 40,
    tooltip: 50,
    toast: 60,
    lightbox: 70,
  },

  // ── Transition helpers ──
  transition: {
    fast: "80ms cubic-bezier(0.16, 1, 0.3, 1)",
    normal: "150ms cubic-bezier(0.16, 1, 0.3, 1)",
    slow: "250ms cubic-bezier(0.16, 1, 0.3, 1)",
    colors: "150ms cubic-bezier(0.16, 1, 0.3, 1)",
    transform: "150ms cubic-bezier(0.16, 1, 0.3, 1)",
    shadow: "250ms cubic-bezier(0.16, 1, 0.3, 1)",
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

// CSS custom property names (kebab-case)
export const cssVars = {
  // Color
  bg: "--color-bg",
  bgElevated: "--color-bg-elevated",
  bgSunken: "--color-bg-sunken",
  line: "--color-line",
  lineStrong: "--color-line-strong",
  lineGlow: "--color-line-glow",
  text: "--color-text",
  textMuted: "--color-text-muted",
  textFaint: "--color-text-faint",
  textInverted: "--color-text-inverted",
  accent: "--color-accent",
  accentText: "--color-accent-text",
  accentMuted: "--color-accent-muted",
  ok: "--color-ok",
  okGlow: "--color-ok-glow",
  warn: "--color-warn",
  warnGlow: "--color-warn-glow",
  err: "--color-err",
  errGlow: "--color-err-glow",
  run: "--color-run",
  runGlow: "--color-run-glow",
  neon: "--color-neon",
  neonSoft: "--color-neon-soft",
  neonMed: "--color-neon-med",
  neonStrong: "--color-neon-strong",
  codeBg: "--color-code-bg",
  codeLine: "--color-code-line",

  // Space (mapped to --space-{n})
  space: (n: number | string) => `--space-${n}`,

  // Type
  fontSans: "--font-sans",
  fontMono: "--font-mono",
  typeSize: (step: string) => `--type-size-${step}`,
  typeWeight: (w: string) => `--type-weight-${w}`,
  lineHeight: (k: string) => `--line-height-${k}`,
  letterSpacing: (k: string) => `--letter-spacing-${k}`,

  // Radius
  radius: (k: string) => `--radius-${k}`,

  // Elevation
  elevation: (k: string) => `--elevation-${k}`,

  // Motion
  duration: (k: string) => `--duration-${k}`,
  easing: (k: string) => `--easing-${k}`,

  // Breakpoints (for container queries / media)
  breakpoint: (k: string) => `--bp-${k}`,

  // Z-index
  zIndex: (k: string) => `--z-${k}`,
} as const;
