# Concepts

The ideas behind SwarmAgents, in plain language. If you just want to run
something, start with [Getting started](getting-started.md). This page
explains the pieces you will see in the UI and the docs.

## Run

A **run** is one unit of agent work: you send a prompt, the agent works
toward it, and the run ends with a result (or a clear error). Each run
streams typed events — the agent started, it said something, it called a
tool, the tool returned, the run finished — so the UI can show progress
live and replay it later.

One run is active per account at a time. Prompts sent while a run is
active queue behind it (a small FIFO queue) and start in order. You can
cancel the active run and its queue, or remove a single queued prompt.
A finished run records its session, cost, duration, and turn count in
your run history, and a later prompt can resume the same session so the
agent keeps its context.

## VM (your agent's computer)

Every account gets its own **persistent Linux VM** — a real machine with a
shell, files, a browser, and (where enabled) a desktop the agent can
drive. The agent works *inside* that VM, not on your laptop and not in a
shared pool.

Key properties:

- **Persistent workspace.** Files in `/workspace` survive between runs,
  VM restarts, and idle stops. Installed tools and project state carry
  over.
- **Sandboxed by design.** The VM runs with hard resource ceilings
  (memory, CPUs, process count) and a hardened security profile, so a
  runaway process in one VM cannot starve the host or reach another
  user's machine.
- **Idle-aware.** After a period without activity the VM is stopped to
  save resources; the next run restarts it transparently. A VM with work
  in flight is never stopped.
- **Resettable.** You can wipe the VM and start from a clean machine when
  you want a fresh environment.

The hosted service runs VMs as containers on its servers. With BYOC
(below), the VM can instead be a machine you own.

## Provider and BYOK (bring your own key)

A **provider** is a model vendor (for example Anthropic, OpenAI, or
Google) whose models power the agent. SwarmAgents routes each run to a
model you choose.

**BYOK** means the keys are yours: each account saves its own provider
keys in Settings, encrypted on the server and scoped to that account.
Keys are only ever displayed masked (last four characters), are passed
to the agent through the VM environment only (never in command lines or
logs), and are scrubbed from everything the run streams back. A run only
ever uses keys saved on the caller's own account — there is no shared
pool for signed-in users, and no account can list, read, or route
through another account's providers.

If a provider rate-limits a key, the router cools that key down and
rotates to the next one; cooldowns survive server restarts so a limited
key is not hammered again immediately.

## BYOC (bring your own computer)

**BYOC** lets your own machine serve as the agent's computer. You pair a
node (a small agent program running on hardware you control) with your
account using a one-time pairing code; runs can then execute there
instead of on the hosted VM fleet. Your files stay on your machine by
default, and you can revoke a paired node at any time, which ends its
live session immediately.

BYOC is the answer when the work needs your local files, your network,
or compute you already own. The hosted VM is the answer when you want
zero setup. Both run the same agent loop.

## Takeover

**Takeover** hands you the keyboard and mouse of the agent's computer
mid-run. The agent pauses its input while you drive — log in to a site,
solve a CAPTCHA, click through a flow — then you hand control back and
the agent continues from the state you left. Takeover is for moments
where a human touch is faster or required; everything else, the agent
does itself while you watch.

## Approval gate (allow / ask / deny)

Every tool call the agent makes is classified *before* it executes:

| Level | Meaning | Examples |
| --- | --- | --- |
| `allow` | Benign; runs without asking | Reading files, local builds, running tests |
| `ask` | Risky but legitimate; pauses for your decision | Destructive deletions, piping a download into a shell, container commands, force git operations, reading credential files, `sudo`, firewall or service changes |
| `deny` | Never allowed; no approval can lift it | Printing secret environment variables, reading system credential files, cloud metadata endpoints |

An `ask` decision pauses the run on an approval card. Approve and the
action proceeds; deny (or let the card expire) and the run stops with a
policy error. Deny always wins over ask, and ask always wins over allow.
The classifier itself never executes anything — it only judges.

## Trajectories and replay

A run's full event stream is its **trajectory**: every message, tool
call, and result, in order, with sequence numbers. Trajectories power
three things you can see:

- **Live streaming with resume.** Disconnect and reconnect; the stream
  replays from where you left off instead of dropping events.
- **Run history and review.** Finished runs keep their trajectory so you
  can audit exactly what the agent did, what it cost, and how long it
  took.
- **Sharing.** A watch-only share link lets someone follow a run live
  without control — useful for demos and support.

## Memory

The agent can keep **long-term memory** per account: preferences, notes
about a codebase, facts worth carrying between runs. Memories are stored
under your account, searchable, and deletable — including a "clear all"
that forgets everything. Memory is what makes the tenth run smarter than
the first without you re-explaining yourself.

## Roles and agents

A **role** (agent card) packages a way of working: instructions, tool
allowances, and defaults for a kind of task — bug fixing, research, data
work. You pick a role when starting a run, or define your own agents
from a manifest. Roles change how the agent approaches the task; the VM,
approval gate, and streaming stay the same.

## Projects and templates

A **project** groups runs around a codebase or workspace (name, repo,
branch), so context and history stay together. **Templates** are named
starting points — a prompt plus settings you can launch in one click and
then make your own. Both are conveniences over the same run loop, not
separate products.

## The board (internal coordination)

The **swarm board** is how SwarmAgents' own builders coordinate: a task
board with claims, proposals, and messages, exposed to coding agents over
MCP. It is internal build tooling, not a product feature — your runs do
not depend on it, and it is documented here only so the API reference
below makes sense. If you are building *on* SwarmAgents, you can ignore
the board entirely.

## How the pieces fit

```text
You (chat bar)
  -> Run (one active, FIFO queue)
      -> Agent loop (plan, call tools, stream every event)
          -> Your VM (hosted container, or your BYOC machine)
          -> Your provider key (your account, your model choice)
      -> Approval gate (allow / ask / deny before every tool call)
      -> Trajectory (live stream, replay, history, share links)
```

Next: [Getting started](getting-started.md) to run your first task,
[Self-hosting](self-hosting.md) to run the platform yourself, or the
[API reference](api/README.md) to automate it.
