/**
 * Capability gating for the workspace UI.
 *
 * Lifted from the "universal-autonomous-computer-platform" prototype, whose one
 * genuinely superior idea was to *never pretend*: a control whose backend is
 * missing is rendered disabled with the reason attached, and the settings view
 * states plainly what this deployment can and cannot do ("No simulated stream ·
 * Actual desktop only").
 *
 * SwarmAgents grew a lot of half-available features (VM driver, desktop mode,
 * BYOK providers, the second harness adapter), and the honest answer is often
 * "this build cannot do that yet" rather than a spinner. Keeping the decision in
 * a pure function means every caller gates the same way and the reasons stay
 * testable.
 */

export type CapabilityId =
  | "vm"
  | "desktop"
  | "providers"
  | "agents"
  | "snapshots"
  | "livePreview";

export type CapabilityState = "ready" | "unavailable" | "degraded";

export interface Capability {
  id: CapabilityId;
  label: string;
  state: CapabilityState;
  /** One sentence a user can act on. Always present. */
  detail: string;
}

export interface CapabilitySignals {
  /** SWARM_VM_DRIVER / the health payload's vmDriver. */
  vmDriver?: string | null;
  /** True when a provider is configured for the account. */
  providersConfigured?: boolean;
  /** True when the VM reports a desktop session. */
  desktop?: boolean;
  /** True when the agent store is usable (it is, whenever the app booted). */
  agentsEnabled?: boolean;
}

/**
 * Derive the capability list. Pure and defensive: a missing signal is treated
 * as "unavailable" rather than optimistically true, because a disabled control
 * costs a user a click while a fake-enabled one costs them trust.
 */
export function deriveCapabilities(signals: CapabilitySignals = {}): Capability[] {
  const driver = (signals.vmDriver ?? "").toLowerCase();
  const fakeVm = driver === "fake";
  const hasVm = driver.length > 0 && driver !== "none";
  const providers = signals.providersConfigured === true;
  const desktop = signals.desktop === true;

  return [
    {
      id: "vm",
      label: "VM runs",
      state: !hasVm ? "unavailable" : fakeVm ? "degraded" : "ready",
      detail: !hasVm
        ? "No VM driver is configured, so agent runs cannot start."
        : fakeVm
          ? "The fake VM driver is active: runs replay a recorded transcript instead of executing."
          : `Runs execute with the "${driver}" driver.`,
    },
    {
      id: "providers",
      label: "Model providers",
      state: providers ? "ready" : "unavailable",
      detail: providers
        ? "At least one provider is configured for this account."
        : "Add a provider key in Settings (BYOK) before an agent can call a model.",
    },
    {
      id: "desktop",
      label: "Desktop stream",
      state: desktop ? "ready" : "unavailable",
      detail: desktop
        ? "The VM reports a desktop session."
        : "No desktop session is attached; the desktop view stays observation-only.",
    },
    {
      id: "agents",
      label: "Agent Studio",
      state: signals.agentsEnabled === false ? "unavailable" : "ready",
      detail:
        signals.agentsEnabled === false
          ? "The agent store could not be opened."
          : "Agents can be created, exported and deployed to the SwarmAgents harness.",
    },
    {
      id: "snapshots",
      label: "Checkpoints",
      state: hasVm && !fakeVm ? "ready" : hasVm ? "degraded" : "unavailable",
      detail: !hasVm
        ? "Checkpoints need a running VM."
        : fakeVm
          ? "Checkpointing is exercised against the fake driver only."
          : "Checkpoints commit the container and back up its workspace volume.",
    },
    {
      id: "livePreview",
      label: "Live preview",
      state: hasVm && !fakeVm ? "ready" : "unavailable",
      detail: hasVm && !fakeVm
        ? "Preview ports inside the VM are proxied for HTTP and WebSocket."
        : "Live preview needs a real VM with a listening port.",
    },
  ];
}

export interface Gate {
  disabled: boolean;
  /** Present exactly when `disabled` is true. */
  reason?: string;
}

/**
 * Whether a control requiring `id` may be pressed, and why not.
 *
 * `degraded` is deliberately allowed through: it means "works differently than
 * you may assume", which the caller surfaces as a hint rather than a block.
 */
export function gate(capabilities: readonly Capability[], id: CapabilityId): Gate {
  const capability = capabilities.find((entry) => entry.id === id);
  if (!capability) {
    return { disabled: true, reason: `This build has no "${id}" capability.` };
  }
  if (capability.state === "unavailable") {
    return { disabled: true, reason: capability.detail };
  }
  return { disabled: false };
}

/** A hint to show next to an enabled-but-degraded control. */
export function degradedHint(capabilities: readonly Capability[], id: CapabilityId): string | null {
  const capability = capabilities.find((entry) => entry.id === id);
  return capability && capability.state === "degraded" ? capability.detail : null;
}

export function capabilityTone(state: CapabilityState): "ok" | "warn" | "off" {
  if (state === "ready") return "ok";
  if (state === "degraded") return "warn";
  return "off";
}
