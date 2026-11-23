# Brand UI library

Hand-built components on the SwarmAgents brand system — Void Navy, Signal
Cyan, the cursor-eye mark, and the 13 hand-authored icons. No component
libraries, no generated artwork: every element here is code.

Brand source of truth: `apps/swarmagents/branding/BRAND.md` (PR #181).
Icons: `apps/swarmagents/public/brand/icons/` (sprite + individual SVGs).

## Setup

Import the tokens once at the app root (they are plain CSS custom
properties; components reference them, never hard-coded hex):

```tsx
import "./components/brand/tokens.css";
```

The icon sprite must be reachable at `/brand/icons/sprite.svg` (it ships
with PR #181). Override per-icon with the `spriteHref` prop if your base
path differs.

## Components

| Component | What it is |
|---|---|
| `ChatBar` | The one chat bar: auto-growing textarea, Enter runs, Shift+Enter newlines, attach, send→stop while running, disabled-with-reason. |
| `VmViewport` | Live VM screen frame: chrome bar (status pill, takeover, fullscreen), 16:9 stage, optional footer strip. Screen content is `children`. |
| `TakeoverButton` | "Take over" / "Hand back" — one slot, current driver always obvious. |
| `PrimaryButton` / `GhostButton` | Signal fill / quiet secondary. Loading + disabled states, focus rings. |
| `Card` | Raised surface: hairline, top light, optional hover for clickable cards. |
| `StatusPill` | Dot + word in five tones; `running` breathes. |
| `EmptyState` | Ringed brand icon, title, starter-task chips that fill the chat bar. |
| `LoadingState` / `Skeleton` / `Spinner` | Shimmer skeletons + the Signal spinner ring. |
| `SettingsPanel` | Top-right slide-over shell: Esc/scrim close, focus in/out, pinned footer. |
| `Toast` / `ToastViewport` | Bottom-right notices, tone icons, auto-dismiss, aria-live. |
| `Icon` | One of the 13 brand icons from the sprite, `currentColor`. |

All components: typed props, keyboard accessible (focus-visible rings,
aria labels, real buttons), dark theme primary, reduced-motion respected
(see the `@media (prefers-reduced-motion: reduce)` block in tokens.css).

## Usage sketch

```tsx
import { ChatBar, EmptyState, VmViewport } from "./components/brand";

<VmViewport
  title="Desktop"
  status="running"
  statusLabel="Live"
  live
  driver={driver}
  onTakeover={takeOver}
  onHandback={handBack}
  footer={<span>vm-01 · connected · 2s ago</span>}
>
  {/* noVNC canvas / video surface */}
</VmViewport>

<ChatBar
  value={task}
  onChange={setTask}
  onSubmit={runTask}
  onStop={stopRun}
  running={isRunning}
  onAttach={openFilePicker}
/>

<EmptyState
  title="Give it a task. It has its own computer."
  description="Describe the work. Watch every step stream live. Take over whenever you want."
  starters={[{ label: "Fix the failing tests" }, { label: "Research and summarize" }]}
  onStarterSelect={setTask}
/>
```

## Token reference (tokens.css)

**Palette** — `--brand-void` #13192C · `--brand-signal` #00D0F0 ·
`--brand-deep` #005080 · `--brand-ink` #0B1020 · `--brand-paper` #FFFFFF ·
`--brand-mist` #B4BED2.

**Derived surfaces** — `--brand-surface` / `-raised` / `-hover` (Void
lifted toward Paper), `--brand-well` (inset stage), `--brand-hairline`
(-strong), `--brand-top-light`.

**Text** — `--brand-text` (body on dark), `-2` (Mist), `-3` (faint),
`--brand-text-on-signal` (Ink on cyan fills).

**Status** (status only) — `--brand-ok` #34D399 · `--brand-warn` #FBBF24 ·
`--brand-err` #FB7185.

**Spacing** — `--brand-space-1…12`, 4px base. **Radii** — sm 6 / md 10 /
lg 14 / xl 20 / full. **Shadows** — card / pop / stage + `--brand-glow-signal`
+ `--brand-focus-ring`. **Type** — `--brand-font-sans` (Inter → system),
`--brand-font-mono`; sizes xs 11 → 2xl 28. **Motion** — fast 120ms /
base 180ms / slow 320ms, `--brand-ease-out`.

JS mirror for the values code needs: `tokens.ts` (`BRAND_COLORS`,
`BRAND_MOTION_MS`, `BRAND_SPACING`, `ICON_NAMES`). Keep it in sync with
tokens.css — `tokens.test.ts` guards the palette and icon list.

## Relationship to existing UI code

- `design/primitives.tsx` + `design/capabilities.ts` — workspace primitives
  on the pre-brand palette (black/neon). The capability-gating rule
  ("disabled with a reason, never pretend") is carried into `ChatBar` and
  `TakeoverButton` here.
- `components/ui.tsx` — the main workspace control vocabulary (lucide
  icons, `sa-*` tokens). This library is the brand-palette counterpart for
  the minimalist surface; migrate surface by surface, don't big-bang.

## Integration follow-ups (not in this PR)

1. Import `tokens.css` in `minimalist-ui/src/main.tsx` (or index.css) and
   swap App.tsx's ad-hoc input bar / viewport chrome for `ChatBar` /
   `VmViewport` — App.tsx is a hot file with open PRs, so wiring waits for
   a quiet moment.
2. Serve the icon sprite with the minimalist build (PR #181 lands it in
   the main app's `public/brand/icons/`; confirm the minimalist surface
   resolves `/brand/icons/sprite.svg`, else pass `spriteHref`).
3. Add a `/design` showcase section rendering these components against
   real `/api/health` capabilities, like the existing primitives page.
