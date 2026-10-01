# Long-running task acceptance

This is the release gate for claiming that SwarmAgents can keep one task moving through long runs and interruptions. A successful typecheck or build is not an endurance result. Record evidence, environment, and duration for each run; never infer a 24-hour pass from short simulations.

## Gates

| Area | Stimulus | Required behavior | Evidence to record |
| --- | --- | --- | --- |
| Provider quota | Return 429 with `Retry-After`, then recover | Show a clear waiting state and countdown; do not busy-loop; resume the same task automatically when permitted | provider, retry headers, wait duration, turn/event IDs |
| Provider outage | Timeout or 5xx for at least 10 minutes, then recover | Bounded exponential backoff with jitter; one visible status; no duplicated user turn or runaway request rate | request timestamps/count, backoff sequence, recovery event |
| Process restart | Restart during a read, write, and external side-effect tool call | Persist task and event history; mark in-flight side effects as uncertain; inspect state before retry; never replay blindly | task/session IDs, tool call IDs, recovery notices, inspected state |
| Steering | Send at least 20 messages while tools are running, including during a provider wait | Queue and apply each steer once, in order; latest steer survives context compaction verbatim; UI remains usable | sent/applied message IDs and final transcript |
| Context pressure | Drive estimated context past each compaction threshold repeatedly | Preserve original goal, recent user steering, current plan, tool outcomes and file paths; resume with a valid provider transcript | compaction events, pre/post token estimates, retained-tail inspection |
| Stop and continue | Stop during a tool call, then continue the task | Stop promptly; represent uncertainty honestly; continue only after state inspection; no orphaned running indicator | stop latency, tool state, subsequent action trace |
| Durable artifacts | Create/edit files, checkpoints, plans and task events, then restart | All completed artifacts and undo checkpoints remain available and correspond to disk state | paths, checkpoint IDs, hashes, before/after restart |
| Storage bounds | Upload near-limit and over-limit files; interrupt transfers; repeat until disk reserve boundary | Reject over-limit input before/while streaming, preserve configured free-space reserve, remove partial uploads, explain failure in Composer | configured cap/reserve, bytes written, free-space before/after, partial-file scan |
| UI state | Observe waiting, running, tool execution, recovery, stop, completion and failure | One task view always distinguishes these states; elapsed time/progress reflect persisted events and never imply success after failure | screenshots plus session/event timestamps |
| Secret handling | Run shell and MCP child processes while auth and provider secrets are configured | Children receive only credentials explicitly required for that integration; owner auth token is not exposed; settings/API responses redact secrets | child environment key names, API response scan, deploy env mode (never capture secret values) |

## Run protocol

1. Record commit, image digest, machine/container limits, provider/model, configured upload cap and reserve, and start time.
2. First run deterministic fault injections for quota, timeout, restart, context pressure, and interrupted upload. These verify each recovery path without waiting a day.
3. Run the full 24-hour soak with a task that alternates read-only research, bounded file edits, user steering, and provider waits. Include at least one controlled process restart and one provider outage. Avoid real purchases, messages, or other external irreversible actions.
4. Capture task/session IDs, event log, provider request times, disk usage, restart points, and artifact hashes. Redact secrets.
5. Pass only when every gate above has evidence, no data loss or blind side-effect replay occurred, task/history/upload storage stayed bounded, and the user-facing state matched the event log. File defects against their owning lane and rerun affected gates.

## Current status

- Acceptance criteria documented; no 24-hour soak has been run or passed.
- Known blocker: compaction tail selection must preserve the newest user steer verbatim.
- Short deterministic e2e harness has reported compaction as its sole failing case; latest owner report is pending.
