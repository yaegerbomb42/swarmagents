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
 * Presentational only — the decision of when it shows lives in
 * `firstRunSetup` (hooks/useEnvironment.ts), which is unit-tested.
 */

import React from "react";
import { Button } from "./ui";

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
        SwarmAgents runs on your own model provider keys (BYOK). Runs use the keys stored on the
        server, so add one in Settings and your first task can start.
      </p>
      <div className="mt-5">
        <Button variant="primary" onClick={onOpenProviders} data-testid="first-run-add-provider">
          Add provider key
        </Button>
      </div>
    </div>
  );
}

export default FirstRunSetup;
