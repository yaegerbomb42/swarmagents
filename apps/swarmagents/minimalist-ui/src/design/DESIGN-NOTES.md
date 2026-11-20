# Design notes — what was taken from the three prototypes, and why

Three Next.js prototypes were handed over (`universal-autonomous-computer-platform`,
`autonomous-ai-computer-platform`, `autonomous-human-ai-computing-architecture`). This
is the audit of what is actually worth taking into SwarmAgents, and what is not.

## Adopted

| Source | What | Why it is better than what we have |
| --- | --- | --- |
| **universal-autonomous-computer-platform** | Capability gating: a control whose backend is missing renders disabled **with the reason**, and a settings view that states plainly what the deployment can do ("No simulated stream · Actual desktop only"). | Our UI offers buttons that either 404 or silently do nothing when the VM driver, provider key or desktop session is absent. This is the single best idea in the three bundles: refuse to pretend. Ported to `capabilities.ts` + `GateButton` / `CapabilityCard`. |
| **autonomous-ai-computer-platform** | The step rail (numbered node → check → cross, connector line) and the event row (tone dot + type + time + detail). Also the 9–13px type ladder, 0.13em uppercase micro-labels and 1px hairlines. | Our Plan drawer is four hardcoded steps for every run — mock data in a real product surface. The rail is the same idea done honestly, and the micro-label/hairline craft reads more precise than our current 11px `uppercase tracking-wide`. Ported to `primitives.tsx` (`StepRail`, `EventList`, `MicroLabel`, `SectionHeading`). |
| **autonomous-ai-computer-platform** | Light theme as a first-class option, driven by the same token names (`[data-theme="light"]` overriding `--bg/--surface/--line/--text`). | We only ship a black canvas. Not enabled here, but the token indirection is worth copying if a light workspace is ever wanted. |
| **autonomous-human-ai-computing-architecture** | The execution rail as a *tabbed* right rail (Plan / Trace / Timeline / Vault) with a pinned footer state line, and the drag-to-reorder plan. | Our right drawer already has tabs, so the structure drops in; the pinned footer (`policy: … · auto-run off`) is a better place for run state than a badge in the header. Structure adopted; drag-reorder deliberately not (see below). |
| **all three** | Empty states that explain the next action instead of showing a spinner or zeroes, with pure-CSS art that cannot fail to load. | Our empty states are single lines of grey text. |

## Rejected, with reasons

- **The olive/lime palette (`#d4eeae` on `#0b0c0e`).** It is genuinely good, but SwarmAgents' brand is pure black with neon white (`app/globals.css`, `--color-accent: #ffffff`). Swapping the identity in a design PR would be a product decision, not a design improvement. The primitives read from `--color-ok / warn / err / run`, so adopting the palette later is a token change, not a refactor.
- **`autonomous-ai-computer-platform`'s 561-line `globals.css`.** Beautiful, but it is a *parallel* design system: plain CSS classes that would fight Tailwind + our existing tokens. Only the craft (scale, spacing, hairlines, tints) was taken, expressed in Tailwind utilities over our own variables.
- **Drag-to-reorder the plan.** Nice, and it depends on a plan model the backend does not expose yet. Shipping the drag without the model would be decoration.
- **The fake-desktop scene from bundle #1's canvas.** It is honest in *that* prototype (it says "Runtime not connected"), but building chrome for a desktop we do not render is the exact thing that prototype was refusing to do.
- **Duplicated plumbing.** All three bundles re-implement providers, secrets, storage and event streams. None of that is better than `lib/providers`, `lib/runtime` and `lib/vault`; only the UI ideas were portable.

## Where this is applied

- `/design` renders every primitive against **this deployment's real** `/api/health` capabilities, so the page is also a truthful capability statement.
- Nothing was migrated yet: `AgentLibrary` / `AgentStudio` / `RightDrawer` still own their styling. Migration order that costs the least and shows the most:
  1. `RightDrawer` Plan tab → `StepRail` fed by the run timeline (kills the four hardcoded steps).
  2. Run report / event list → `EventList` + `StatusPill`.
  3. Provider + agent empty states → `EmptyState`.
  4. Any control that needs the VM, a provider or the desktop → `GateButton` with its `CapabilityId`.

## The blocker this uncovered: every button in the app was unstyled

Rendering the showcase in a real browser is what caught it. The gated buttons came
out as bare text, so I inspected the computed styles instead of trusting the markup:

```
Publish  class="rounded-md border border-cyan-400/30 bg-cyan-400/10"
         computed: border-width 0px · background transparent · padding 0px
```

The cause is in `app/globals.css`: the element resets were **unlayered** —

```css
button { background: none; border: 0; padding: 0; }
```

Tailwind v4 emits its utilities into `@layer utilities`, and in the CSS cascade an
unlayered rule beats every layer regardless of specificity. So that reset silently
defeated `border-*`, `bg-*` and `px-*/py-*` on **every** `<button>` in the product,
not just the new ones: the Library's Publish button has been rendering as plain text
despite being authored with a cyan border and tint.

The fix is one level of nesting — the reset now lives in `@layer base`, so base
resets apply first and utilities layer on top, which is what every component in this
repo was already written against. Verified before/after on `/library`: the Publish
pill regains its border and tint, the tab row becomes a real segmented control, the
back button and search field regain their outlines. Buttons are the only affected
element (the `input, textarea, select` reset sets no box properties), and
`provider` routes and the design showcase were re-screenshotted unchanged in layout.

## Housekeeping found on the way

`app/globals.css` begins with "Generated from lib/design-tokens.ts — keep in sync!", but
`lib/design-tokens.ts` no longer exists in the tree. The comment is stale; the tokens are
hand-maintained now. Worth deleting the sentence before someone goes looking for the generator.
