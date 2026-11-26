"use client";

/**
 * SettingsSheet — the one place settings live.
 *
 * Providers comes first because a run cannot start without a model key
 * (bring-your-own-key). Agent holds the few choices that shape a run:
 * whether tool calls ask first, where runs execute, the agent's standing
 * instructions, and resetting the VM. Computers, Memory and Account are the
 * existing panels, unchanged.
 */

import React, { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { ProviderConfig } from "../data";
import type { SampleTask } from "../lib/sampleTasks";
import { DEFAULT_AGENT_CARD } from "../data";
import { MAX_AGENT_CARD_LEN } from "../../../lib/client/runs";
import { cn } from "../utils/cn";
import { ComputePicker, type ComputeOptions } from "./ComputePicker";
import { SchedulesSection } from "./SchedulesSection";
import { Settings, type SettingsTab } from "./Settings";
import { Button, Notice, Sheet } from "./ui";

export interface AgentSettingsProps {
  fullAuto: boolean;
  onFullAutoChange: (fullAuto: boolean) => void;
  agentCard: string;
  onAgentCardChange: (card: string) => void;
  compute: ComputeOptions;
  /** A run is active: the VM cannot be reset under it. */
  busy: boolean;
  onResetVm: () => Promise<string | undefined>;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-sa-fg">{title}</h3>
        {hint && <p className="mt-0.5 text-[13px] leading-relaxed text-sa-fg2">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

const APPROVAL_MODES = [
  {
    fullAuto: true,
    label: "Run without asking",
    hint: "Tool calls run right away. Everything still happens inside the VM.",
  },
  {
    fullAuto: false,
    label: "Ask before risky actions",
    hint: "The run pauses and asks you to approve or deny each risky tool call.",
  },
] as const;

export function AgentSettings({
  fullAuto,
  onFullAutoChange,
  agentCard,
  onAgentCardChange,
  compute,
  busy,
  onResetVm,
}: AgentSettingsProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string>();
  const [resetDone, setResetDone] = useState(false);

  const reset = async () => {
    setResetting(true);
    setResetError(undefined);
    setResetDone(false);
    const problem = await onResetVm();
    setResetting(false);
    setConfirmReset(false);
    if (problem) setResetError(problem);
    else setResetDone(true);
  };

  return (
    <div className="sa-app space-y-8 bg-transparent" data-testid="agent-settings">
      <Section title="Approvals" hint="Applies to the next run you start.">
        <div role="radiogroup" aria-label="Approvals" className="space-y-2">
          {APPROVAL_MODES.map((mode) => {
            const selected = mode.fullAuto === fullAuto;
            return (
              <button
                key={mode.label}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={mode.fullAuto ? "approvals-auto" : "approvals-ask"}
                onClick={() => onFullAutoChange(mode.fullAuto)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  selected ? "border-sa-accent-fg bg-sa-accent/10" : "border-sa-line hover:bg-sa-hover",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                    selected ? "border-sa-accent-fg" : "border-sa-line-strong",
                  )}
                >
                  {selected && <span className="h-2 w-2 rounded-full bg-sa-accent-fg" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-sa-fg">{mode.label}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-sa-fg2">{mode.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Run on" hint="Where the agent's VM runs.">
        <ComputePicker options={compute} busy={busy} testId="settings-compute" />
      </Section>

      <Section title="Instructions" hint="Standing instructions the agent gets with every run.">
        <textarea
          value={agentCard}
          onChange={(event) => onAgentCardChange(event.target.value.slice(0, MAX_AGENT_CARD_LEN))}
          rows={8}
          maxLength={MAX_AGENT_CARD_LEN}
          aria-label="Agent instructions"
          data-testid="agent-instructions"
          spellCheck={false}
          className="sa-scroll w-full resize-y rounded-lg border border-sa-line-strong bg-sa-bg px-3 py-2 text-base leading-relaxed text-sa-fg outline-none placeholder:text-sa-fg3 sm:text-[13px]"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="sa-tabular text-[12px] text-sa-fg3">
            {agentCard.length} / {MAX_AGENT_CARD_LEN}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={agentCard === DEFAULT_AGENT_CARD}
            onClick={() => onAgentCardChange(DEFAULT_AGENT_CARD)}
          >
            Restore default
          </Button>
        </div>
      </Section>

      <SchedulesSection />

      <Section
        title="Reset the VM"
        hint="Wipes the VM back to a clean machine. Files in its workspace and anything running in it are lost."
      >
        {resetError && (
          <Notice tone="err" title="The VM was not reset">
            {resetError}
          </Notice>
        )}
        {resetDone && <Notice title="The VM was reset to a clean machine" />}
        {confirmReset ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" loading={resetting} onClick={() => void reset()} data-testid="reset-vm-confirm">
              Yes, wipe the VM
            </Button>
            <Button variant="ghost" disabled={resetting} onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            disabled={busy}
            title={busy ? "Stop the run before resetting the VM" : undefined}
            onClick={() => {
              setResetDone(false);
              setConfirmReset(true);
            }}
            data-testid="reset-vm"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reset VM
          </Button>
        )}
      </Section>
    </div>
  );
}

const TABS: SettingsTab[] = ["providers", "agent", "computers", "memory", "account"];

export interface SettingsSheetProps extends AgentSettingsProps {
  open: boolean;
  onClose: () => void;
  /** The tab to show when the sheet opens. */
  initialTab?: SettingsTab;
  providers: ProviderConfig[];
  setProviders: (fn: (p: ProviderConfig[]) => ProviderConfig[]) => void;
  serverProviderCount: number;
  /** Notified when the 24/7 always-on toggle loads or changes (header badge). */
  onAlwaysOn247Change?: (value: boolean) => void;
  /** Dispatch a sample task through the normal run path (Account tab replay). */
  onRunSample?: (sample: SampleTask) => Promise<{ ok: boolean; error?: string }>;
}

export function SettingsSheet({
  open,
  onClose,
  initialTab = "providers",
  providers,
  setProviders,
  serverProviderCount,
  onAlwaysOn247Change,
  onRunSample,
  ...agent
}: SettingsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Settings" testId="settings-sheet">
      <Settings
        // Remount per opening so the requested tab is the one shown.
        key={initialTab}
        open
        embedded
        onClose={onClose}
        tabs={TABS}
        initialTab={initialTab}
        agentPanel={<AgentSettings {...agent} />}
        providers={providers}
        setProviders={setProviders}
        serverProviderCount={serverProviderCount}
        onAlwaysOn247Change={onAlwaysOn247Change}
        onRunSample={onRunSample}
      />
    </Sheet>
  );
}

export default SettingsSheet;
