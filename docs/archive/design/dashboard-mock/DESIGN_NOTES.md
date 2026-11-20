# SwarmAgents — design note

**Concept.** The agent's computer is the hero; everything else is quiet furniture around it. Linear's restraint plus Vercel's crisp borders: near-black surfaces (#09090b → #0e0e11), 1px `white/[0.07]` hairlines, one accent (indigo-400/500) used only for "agent is acting / you can act" (live pulse, primary buttons, focus ring, take-over frame).

**Colour rules.** Accent = indigo. Semantics are reserved for status only: emerald = finished/healthy, rose = error/high risk, amber = needs approval. Role colours (Main, Researcher, Builder, Reviewer, DevOps) appear only as small tinted glyph chips, so they never compete with the accent.

**Hierarchy.** Screen (16:10, rendered at a fixed 1280×800 and scaled with ResizeObserver, so the mock is pixel-consistent from 390px to fullscreen) → one-line streaming narration → metrics + collapsible step history → composer. Width is capped by viewport height so screen + strip + composer fit a 1440×900 window without scrolling.

**Control model.** View only ↔ Take over is a segmented control on the screen itself. Take over paints an accent frame + glow, adds a top banner ("You're in control. The agent is paused."), swaps the terminal for a live input, disables the composer and the pause button, and Esc hands control back. Approval *replaces* the narration row (it interrupts the telemetry), takes focus, shows the exact command, reason, impact, a 3-segment risk meter and Approve / Deny / Always allow for this run. Decisions are appended to step history so the audit trail stays in one place.

**Motion.** Narration streams char-by-char and only re-streams the changed tail (so "41/52" ticking doesn't retype the sentence); LIVE and running dots ping; indeterminate 1px progress line; agent cursor drifts across the desktop. All animation is disabled under `prefers-reduced-motion`.

**Accessibility.** Visible 2px indigo `:focus-visible` ring everywhere; tabs/menus/switches/radiogroups use proper roles and arrow-key handling; narration is `aria-live=polite`; approval is an `alertdialog`; icon buttons have labels; off-canvas panels are `inert` when closed.

**Responsive.** ≥1024px: collapsible left rail (Ctrl+\\), 360px right drawer. <1024px: rail becomes a left sheet, drawer becomes a bottom sheet, controls collapse to icons, narration wraps, composer keeps role / attach / provider / stop / send on one row.

**States.** The DEV bar switches Empty, Loading, Running, Approval, Finished, Error, Take over. Sending a message from Empty creates a thread, boots the desktop (loading), then runs. Clicking a thread switches to its status. The mock desktop is shared between threads (demo data).
