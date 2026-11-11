import type { Config } from 'tailwindcss';

/** Design tokens live in src/styles/tokens.css; Tailwind maps names to those vars. */
const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          // Legacy names kept; cyan now resolves to the single accent.
          cyan: 'var(--accent)',
          purple: '#8A2BE2',
          navy: 'var(--bg-0)',
          dark: 'var(--bg-1)',
        },
        bg: {
          0: 'var(--bg-0)',
          1: 'var(--bg-1)',
          2: 'var(--bg-2)',
          3: 'var(--bg-3)',
        },
        line: {
          1: 'var(--line-1)',
          2: 'var(--line-2)',
          3: 'var(--line-3)',
        },
        fg: {
          1: 'var(--fg-1)',
          2: 'var(--fg-2)',
          3: 'var(--fg-3)',
          4: 'var(--fg-4)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          strong: 'var(--accent-strong)',
          wash: 'var(--accent-wash)',
        },
        st: {
          running: 'var(--st-running)',
          thinking: 'var(--st-thinking)',
          validating: 'var(--st-validating)',
          blocked: 'var(--st-blocked)',
          done: 'var(--st-done)',
          failed: 'var(--st-failed)',
          queued: 'var(--st-queued)',
          paused: 'var(--st-paused)',
          idle: 'var(--st-idle)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'sans-serif'],
      },
      fontSize: {
        micro: ['11px', { lineHeight: '16px', letterSpacing: '0.04em' }],
        meta: ['12px', { lineHeight: '16px', letterSpacing: '0' }],
        body: ['13px', { lineHeight: '20px', letterSpacing: '-0.006em' }],
        title: ['15px', { lineHeight: '22px', letterSpacing: '-0.012em' }],
        heading: ['18px', { lineHeight: '26px', letterSpacing: '-0.018em' }],
        display: ['24px', { lineHeight: '30px', letterSpacing: '-0.024em', fontWeight: '550' }],
      },
      letterSpacing: {
        eyebrow: '0.04em',
      },
      borderRadius: {
        xs: 'var(--r-xs)',
        'r-sm': 'var(--r-sm)',
        'r-md': 'var(--r-md)',
        'r-lg': 'var(--r-lg)',
      },
      boxShadow: {
        e1: 'var(--e1)',
        e2: 'var(--e2)',
        focus: 'var(--focus-ring)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
        spring: 'var(--ease-spring)',
      },
      transitionDuration: {
        press: 'var(--dur-press)',
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
        panel: 'var(--dur-panel)',
        emph: 'var(--dur-emph)',
      },
    },
  },
  plugins: [],
};

export default config;
