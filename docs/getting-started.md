# Getting started with SwarmAgents

SwarmAgents gives you one autonomous agent with its own persistent Linux
computer. You describe the work in a chat bar; the agent works inside your
own virtual machine (VM) while every step — text, tool calls, results —
streams to you live. You can watch, steer, approve sensitive actions, or
take over the controls at any moment.

**One chat bar. One agent. Every tool. Nothing hidden.**

This guide takes you from zero to your first finished run. It assumes the
hosted service at <https://swarmagents.codes>. If you run your own
deployment instead, see [Self-hosting](self-hosting.md).

## Before you start

You need two things:

1. **An account** on the service.
2. **A model provider key of your own.** SwarmAgents is free to use; it does
   not sell you tokens. Each account connects its own provider keys
   (bring your own key — BYOK), and model usage is billed by your provider
   at their prices. Your keys belong to your account only. They are never
   pooled with or shared with other users.

If you have no provider key yet, create one with any supported provider
first, then come back. You can sign up and explore the workspace before
adding a key, but a run cannot start without one.

## Step 1 — Create your account

Open <https://swarmagents.codes> and choose **Create account** (shown when
sign-ups are open on the deployment; some deployments are invite-only, in
which case you will be asked for an invite code).

Sign up with your email and a password. If the deployment sends a
verification email, click the link in it before your first run — unverified
accounts can sign in and configure providers, but cannot start runs. Lost
the email? Sign in and resend it from the verify-email page.

## Step 2 — Add your provider key

Open **Settings** (top right) and add a provider key for your account:

1. Pick a provider from the catalog.
2. Paste your key. Keys are stored encrypted on the server, scoped to your
   account, and are only ever shown back to you masked to the last four
   characters.
3. Pick the model you want as your default, or leave the provider default.

You can add more than one key per provider, rotate a key in place, or
remove a provider entirely — all from the same settings surface. A run
only ever uses keys saved on your own account.

> **Free-first tip:** if your provider offers a free tier or free credits,
> start there. Your first runs can cost nothing beyond the free allowance,
> and you can switch models per task later.

## Step 3 — Describe your first task

Type what you want done in the chat bar, in plain language. Good first
tasks are small, concrete, and checkable. For example:

- "Fix the failing tests in this project and show me the diff."
- "Research these three tools and write a comparison I can read in five
  minutes, with sources."
- "Set up a dev environment for this repo and show me the app running."
- "Turn this messy CSV into a clean summary table."

Describe the outcome, not the steps. The agent plans and executes inside
its VM; you do not need to script it.

## Step 4 — Watch it work

When you send the task, your VM boots (the first boot takes a little
longer) and the run starts streaming. You will see:

- **The conversation** — the agent's narration, tool calls, and results as
  they happen.
- **The computer view** — the VM's screen, shell, and browser. The agent
  can install software, edit files, run builds and tests, and drive a
  browser or desktop inside the VM.
- **Status** — what the agent is doing right now, and whether it is
  waiting on you.

Everything the agent does is visible. If you disconnect, reconnecting
replays what you missed — the stream resumes where you left off.

## Step 5 — Steer, approve, or take over

You are never locked out of your own run:

- **Steer:** send a follow-up message mid-run to redirect the agent, add
  context, or queue the next instruction. One run is active at a time;
  additional prompts queue behind it.
- **Approve:** sensitive actions (destructive commands, credential-file
  access, privilege changes, and similar) pause and wait for your decision
  on an approval card. If nobody decides in time, the action is refused
  and the run stops with a clear error — it never proceeds silently.
- **Take over:** grab the keyboard and mouse of the VM mid-task — useful
  for logins, CAPTCHAs, or anything you would rather do yourself — then
  hand control back.

## Step 6 — Collect the result

When the run finishes, the work is still there:

- **Files** the agent created or edited live in your VM's workspace, which
  persists between runs. Browse them from the workspace file view.
- **Previews:** if the agent started a web app or server in the VM, open
  its preview to try it in your browser.
- **Run history:** past runs keep their transcript, cost, and duration, so
  you can review exactly what happened.

Your VM remembers between runs — installed tools, files, and session
context carry over. Idle VMs are stopped to save resources, but the
workspace volume survives and the next run restarts the machine
transparently.

## Where to go next

- [Concepts](concepts.md) — runs, VMs, providers, approvals, takeover,
  and the other ideas behind the product.
- [Self-hosting](self-hosting.md) — run SwarmAgents on your own server or
  your own machine (BYOC).
- [API reference](api/README.md) — the HTTP surface behind the UI, for
  automation and integrations.
- [Architecture](../apps/swarmagents/README.md) — how the system is built,
  for contributors.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Add a provider key" prompt won't go away | No key saved on your account yet | Settings → add a provider key (Step 2) |
| Run refuses to start: account not verified | Verification email not clicked | Open the email link, or resend from the verify-email page |
| Run refuses to start: provider error | Key invalid, out of quota, or rate-limited | Check the key in Settings; try another model or wait out the cooldown |
| Approval card expired and the run stopped | No decision before the timeout | Re-run the task and decide on the card when it appears |
| VM seems slow on the first task | First boot builds your machine | Give the first run a minute; later runs reuse the warm VM |
| Login bounces back to the login page | Secure-cookie mismatch on a plain-HTTP deployment | Self-hosters: see the cookie note in [Self-hosting](self-hosting.md) |
