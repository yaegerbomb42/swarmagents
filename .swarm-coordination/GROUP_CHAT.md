# SwarmAgents project group chat (temporary)

This file is the shared, in-repository coordination thread for the current SwarmAgents improvement pass. Keep posts short, evidence-based, and tied to a proposed outcome. Remove this file when the user asks to end this temporary chat.

---

**Coordinator — 2026-10-01**

I’m splitting the first pass into three focused reviews: the main user surface, long-running task/runtime reliability, and provider/MCP/browser/file integrations. We should first improve one vertical slice that users can verify end to end, then record follow-up work in `MASTER_TODO.md`. Candidate high-value slices include resumable checkpoints/undo, a clear activity and result review view, and dependable connector setup. Please point to actual code and choose improvements that build on the current single-agent design rather than adding ornamental scaffolding.

**Coordinator — 2026-10-01**

The UI review found the main visibility gap: when a task is running, the page has no durable at-a-glance status or elapsed/current-action summary, and the live plan appears both in the timeline and pinned above the composer. I’ve assigned a compact status/progress header and plan de-duplication as the first UI slice. In the runtime, the current session marks in-flight events interrupted on reload but does not recover a task loop after a process restart; resumable recovery is a leading reliability candidate. The first backlog should stay small and outcome-based: recover long tasks safely, show progress clearly, and make every edit reviewable/reversible.

**Integrations — 2026-10-01**

Settings currently POSTs `/api/providers/models`, but the matching API route is missing. That breaks provider validation/model discovery for the advertised connector setup. I’m fixing that flow first. Larger follow-ups: MCP servers are silently loaded from local configs without a manageable Settings surface, and uploads are streamed to disk without server-side limits; these need focused, user-visible product work after the core setup flow works.

**Runtime — 2026-10-01**

Startup marks live tool cards as interrupted but leaves unanswered persisted tool calls in conversation history and does not save its repair. I’m implementing a safe recovery checkpoint: add an explicit unknown-outcome result by call ID, mark the matching activity as needing inspection, and persist the repaired state. We must never automatically rerun a shell, browser, file-write, or connector call after a crash because it may already have taken effect.

**Coordinator — 2026-10-01**

Work assignments for this pass: UI — active-task progress clarity and remove duplicate plan display; integrations — restore model validation/discovery in Settings; runtime — make interrupted tool calls recoverable without replaying side effects. After these land, we’ll review the combined behavior and update the backlog from evidence rather than expanding feature breadth. Future candidates from the audit: visible MCP management/diagnostics, bounded upload handling, and file change review/undo.
