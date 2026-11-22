# SwarmAgents — Brand Sheet

**Tagline:** One chat bar. One agent. Every tool. Nothing hidden.
**Headline:** Give it a task. It has its own computer.

## The mark

The SwarmAgents mark is a geometric **eye** whose pupil is a **terminal cursor block**.
The eye is the promise — every step the agent takes streams live, nothing hidden.
The cursor block is the agent at work — a real computer, running real commands.
Together: autonomy you can watch, and interrupt.

Assets live in `apps/swarmagents/public/brand/` (web) and `apps/swarmagents/branding/` (app icons).

| Asset | File | Use |
|---|---|---|
| Primary logo (dark surfaces) | `public/brand/logo-dark.png` / `.svg` | Headers, README on dark, decks |
| Primary logo (light surfaces) | `public/brand/logo-light.png` / `.svg` | README on light, docs, print |
| Icon (dark) | `public/brand/icon-dark.png` | App icon, avatars, square placements |
| Icon (light) | `public/brand/icon-light.png` | Square placements on light |
| Mark only (transparent) | `public/brand/mark-dark.png` / `mark-light.png`, `.svg` | Watermarks, inline glyphs, loading states |
| Favicons | `public/brand/favicon.svg`, `favicon-16.png` … `favicon-512.png` | Browser favicon, PWA, touch icon |
| Social preview | `public/brand/social-preview.png` (1280×640) | GitHub social preview, link cards |

PNG lockups are canonical (fixed rendering); SVGs are provided for scaling and inline use — SVG wordmark rendering depends on the viewer's fonts.

## Logo usage

- **Clear space:** keep at least the height of the cursor block empty on all sides.
- **Minimum size:** mark 16 px; full lockup 96 px wide. Below that, use the mark alone.
- **Backgrounds:** `logo-dark` / `mark-dark` on Void Navy or darker; `logo-light` / `mark-light` on white or near-white. Never place the cyan mark on a mid-tone or busy photo.
- **Don'ts:** don't recolor the mark outside the palette, don't stretch or rotate it, don't add drop shadows or outlines, don't separate the cursor block from the eye.

## Color palette

| Name | Hex | Role |
|---|---|---|
| Void Navy | `#13192C` | Primary background (dark surfaces) |
| Signal Cyan | `#00D0F0` | Primary accent — the mark on dark, links, active states |
| Deep Signal | `#005080` | The mark on light, headings on light |
| Ink | `#0B1020` | Wordmark + body text on light |
| Paper | `#FFFFFF` | Light background |
| Mist | `#B4BED2` | Secondary text on dark |

Signal Cyan on Void Navy and Deep Signal on Paper both clear WCAG AA for large text and UI components; use Ink/Paper for body copy.

## Typography

- **Wordmark / headlines:** DejaVu Sans Bold (geometric-humanist sans; Inter or system-ui are acceptable substitutes in product UI).
- **Body:** system sans stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`).
- **Code / terminal:** DejaVu Sans Mono or the platform mono stack.
- Headlines are sentence case, short, outcome-first. No exclamation marks in product copy.

## Voice

Plain, confident, and concrete — say what the agent did, not how amazing it is.
Short sentences. Numbers over adjectives. If a claim can't be shown in a live run, don't make it.
We talk like the terminal log reads: factual, timestamped, nothing hidden.
