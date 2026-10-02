# SwarmAgents brand assets

Derived from the user's artwork (originals kept out of git/bundle in `brand-src/`).

| File | Use |
|---|---|
| `mark.svg`, `mark-bold.svg` | Hexagon/cube primary mark, potrace-traced, `fill="currentColor"`. `-bold` is traced from a 5px-dilated bitmap for 32–96px. |
| `mark-small.svg` | Hand-simplified 24px glyph (hex + ring + spokes) for ≤32px (top bar, favicon 16/32). |
| `wrench.svg` | Traced wrench (detailed). `wrench-small.svg` is the 16px glyph used by `ISettings` in components/icons.tsx. |
| `logo.svg` | Full SwarmAgents.codes lockup (traced). `wordmark.svg` is the same without ".codes". |
| `*-white.png` / `*-ink.png` | Tight-cropped transparent PNGs (luminance → alpha, glow dropped) for dark / light surfaces. |
| `*-glow.png` | White with the original glow kept as alpha, for dark surfaces only. |
| `icon-192.png`, `icon-512.png` | Web manifest icons (black, maskable-safe padding). |

In the app the marks are inlined via `components/brand.tsx` (currentColor, no request); the glow is the optional
`.brand-glow` CSS drop-shadow (dark mode only). App icons: `app/favicon.ico`, `app/icon.png`, `app/apple-icon.png`, `app/manifest.ts`.
