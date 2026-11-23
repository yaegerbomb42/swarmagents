"use client";

/**
 * FirstRunSetup — the first screen of an account with no model provider.
 *
 * A fresh account cannot start a run: runs execute on the server with the
 * keys stored there, and there are none yet. Instead of the marketing hero
 * (which invites a message that can only fail), the workspace shows this
 * setup state: what is missing, why, and the one next step. The composer
 * below it is blocked with the same reason, so no run error is reachable.
 *
 * The steps and starter previews set expectations for what happens after
 * setup — describe an outcome, watch the agent's own computer work,
 * approve or take over — so the first run is not a leap of faith. The
 * starter wording matches the hero's STARTERS in App.tsx.
 *
 * Presentational only — the decision of when it shows lives in
 * `firstRunSetup` (hooks/useEnvironment.ts), which is unit-tested.
 */

import React from "react";
import { Button } from "./ui";

const STEPS = [
  {
    title: "Add your provider key",
    body: "Pick a provider in Settings and paste your key. It is stored for your account only and used for your runs — never shared.",
  },
  {
    title: "Describe the outcome",
    body: "Say what done looks like in plain language. The agent plans the steps and works on its own dedicated computer.",
  },
  {
    title: "Watch, approve, take over",
    body: "Follow the live computer as it works, approve sensitive actions before they run, step in whenever you like, and stop the run at any time.",
  },
];

const STARTER_PREVIEWS = [
  "Create a file and run a script",
  "Organize a messy folder",
  "Fetch a web page and summarize it",
];

export function FirstRunSetup({ onOpenProviders }: { onOpenProviders: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-6 text-center" data-testid="first-run-setup">
      <div className="enter flex justify-center mb-6">
        <div className="orb" data-state="idle" style={{ width: 68, height: 68 }}>
          <div className="orb-glow" />
          <div className="orb-core" />
        </div>
      </div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[var(--fg)]">
        Add a provider key to run your first task
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--mute)] leading-relaxed">
        SwarmAgents runs on your own model provider keys (BYOK). Your key is stored for your
        account and used only for your runs, so add one in Settings and your first task can start.
      </p>
      <ol
        data-testid="first-run-steps"
        className="mx-auto mt-6 grid max-w-xl gap-3 text-left sm:grid-cols-3"
      >
        {STEPS.map((step, i) => (
          <li key={step.title} className="rounded-2xl bg-black/20 p-3">
            <p className="font-mono text-[11px] tracking-[0.2em] text-[var(--mute)]">
              {String(i + 1).padStart(2, "0")}
            </p>
            <p className="mt-1.5 text-[13px] font-medium leading-snug text-[var(--fg)]">{step.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--mute)]">{step.body}</p>
          </li>
        ))}
      </ol>
      <div className="mt-5">
        <Button variant="primary" onClick={onOpenProviders} data-testid="first-run-add-provider">
          Add provider key
        </Button>
      </div>
      <div data-testid="first-run-starters" className="mx-auto mt-6 max-w-md">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--mute)]">
          Good first tasks, once your key is saved
        </p>
        <ul className="mt-2 space-y-1 text-sm text-[var(--mute)]">
          {STARTER_PREVIEWS.map((starter) => (
            <li key={starter}>{starter}</li>
          ))}
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-[var(--mute)]">
          The agent works on its own dedicated computer — your machine stays untouched.
        </p>
      </div>
    </div>
  );
}

export default FirstRunSetup;
