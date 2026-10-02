# SwarmAgents UI Experience — Why File & Institutional Knowledge

## Core Purpose & Philosophy
SwarmAgents is an autonomous coding-agent web app built on Next.js 15, React 19, and TypeScript.
Watching the agent work and configuring it must feel premium, calm, and information-dense — exceeding the UX of Devin, Cursor, Antigravity, and Claude Code rather than imitating them.

## Critical Design Decisions
1. **Agent Timeline**:
   - **Step Icons**: Each step (thinking, terminal, read/write/edit file, browser, search, plan, mcp, subagent) has a custom SVG icon for instant recognition without reading text.
   - **Step Grouping**: Consecutive repetitive actions (e.g. reading 14 files or running sequential checks) automatically group into a single summary row with total duration, expanding on demand.
   - **Virtualization via CSS Content-Visibility**: Employs `content-visibility: auto` and `contain-intrinsic-size` so the browser skips rendering offscreen events, keeping 60fps scrolling across 5,500+ steps.
   - **ANSI Color Terminal Rendering**: Shell command outputs render ANSI SGR 16-color, 256-color, and truecolor sequences with truncation limits to prevent memory ballooning.

2. **Long-Run Visibility**:
   - **Progress Hero Bar**: Pinned at the top of active runs, displaying the primary goal, live active action, plan completion fraction, live elapsed timer, token usage (input/output/cached), and real-time cost estimation.
   - **Changed Files Tree**: Gathers every file touched, modified, or downloaded across the entire task run with status badges (+/M/↓) and one-click inline file previews.
   - **Away Recap**: Detects document backgrounding or session returns, displaying a concise summary of all actions, file edits, and token expenditures that occurred while away.

3. **Settings Polish**:
   - Visual health indicator dots (green=ok, amber=cooldown/throttled, red=error) on every connection row for instant status without reading log strings.
   - Preserves all underlying BYOK and MCP connection data models.

4. **Accessibility & Responsive Standards**:
   - `@media (prefers-reduced-motion: reduce)` support instantly disables all animations and transitions.
   - High-contrast `:focus-visible` styling for full keyboard navigation.
   - Fully fluid down to mobile 375px viewports with tabular numerals for zero layout shift.
