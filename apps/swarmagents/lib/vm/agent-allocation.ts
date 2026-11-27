// Per-agent Linux desktop VM allocation (lib/vm/agent-allocation.ts).
//
// Today the runtime gives every user one VM (keyed by userId) and every run
// for that user shares it. This module gives every *agent* its own desktop
// VM: an agent is identified by (userId, agentId), and its VM is a distinct
// container + named /workspace volume + owner label on the docker driver —
// the host is the Oracle VPS in production, where the driver runs the
// containers. Two agents can therefore never see each other's files or
// processes: the docker driver derives container/volume names from a
// SHA-256 fingerprint of the owner key, so distinct keys are injective
// (key scheme: lib/vm/agent-keys.ts). Reuse across the agent's tasks,
// restart fresh per task, and storage persistence all follow the existing
// per-user persistence toggle (lib/runtime/vm-persistence.ts): the
// allocator just applies those decisions to the agent's owner key instead
// of the bare userId.
//
// Env (see docs/self-hosting.md):
//   SWARM_VM_MAX_AGENT_VMS   cap on concurrently live agent VMs (default:
//                            SWARM_MAX_CONCURRENT_VMS, else 4)
//   SWARM_VM_AGENT_IDLE_MIN  minutes of inactivity before the agent-VM
//                            reaper stops an agent VM (default:
//                            SWARM_VM_IDLE_MIN, else 30; 0 = never reap)
//   SWARM_VM_IDLE_MIN / SWARM_VM_ALWAYS_ON_USERS keep their existing
//   meaning: the manager's idle sweeper hibernates agent VMs on the same
//   clock, and an always-on agent VM is never reaped.

import { VmManager } from "./manager";
import type { ExecOptions, ExecResult, VmDesktopEndpoint, VmHandle } from "./types";
import { containerNameFor } from "./docker-driver";
import {
  shouldResetVmAtRunStart,
  shouldStopVmAtRunEnd,
  type VmStartFacts,
  type VmEndFacts,
} from "../runtime/vm-persistence";
import type { VmPersistenceMode } from "../providers/settings";

// Pure key derivation lives in agent-keys.ts (dependency-free, so the
// desktop proxy's narrow build can import it); re-exported here so
// callers of the allocator get the whole surface from one module.
export {
  AGENT_ID_RE,
  DEFAULT_AGENT_ID,
  agentOwnerKey,
  isDefaultAgent,
  isValidAgentId,
  validateAgentId,
} from "./agent-keys";
import { DEFAULT_AGENT_ID, agentOwnerKey } from "./agent-keys";

/** Env var capping concurrently live per-agent VMs. */
export const SWARM_VM_MAX_AGENT_VMS_ENV = "SWARM_VM_MAX_AGENT_VMS";
/** Env var for the agent-VM idle-reap window, in minutes. */
export const SWARM_VM_AGENT_IDLE_MIN_ENV = "SWARM_VM_AGENT_IDLE_MIN";

/** Resolved per-agent VM limits (explicit options over env vars over defaults). */
export interface AgentVmConfig {
  /** Max concurrently live agent VMs (0 or negative disables the cap). */
  maxAgentVms: number;
  /** Minutes of inactivity before the reaper stops an agent VM (0 = never). */
  idleReapMinutes: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the agent-VM config: explicit options win, then
 * SWARM_VM_MAX_AGENT_VMS / SWARM_VM_AGENT_IDLE_MIN, then the matching
 * global VM settings (SWARM_MAX_CONCURRENT_VMS / SWARM_VM_IDLE_MIN),
 * then the defaults (4 VMs, 30 idle minutes).
 */
export function resolveAgentVmConfig(
  opts?: Partial<AgentVmConfig>,
  // Partial: callers only ever read optional SWARM_VM_* vars; tests pass sparse envs.
  env: Partial<NodeJS.ProcessEnv> = process.env,
): AgentVmConfig {
  const maxAgentVms =
    opts?.maxAgentVms ??
    parsePositiveInt(
      env[SWARM_VM_MAX_AGENT_VMS_ENV],
      parsePositiveInt(env.SWARM_MAX_CONCURRENT_VMS, 4),
    );
  const idleReapMinutes =
    opts?.idleReapMinutes ??
    parseNonNegativeNumber(
      env[SWARM_VM_AGENT_IDLE_MIN_ENV],
      parseNonNegativeNumber(env.SWARM_VM_IDLE_MIN, 30),
    );
  return { maxAgentVms, idleReapMinutes };
}

/** Thrown when allocating a new agent VM would exceed the concurrent cap. */
export class AgentVmCapError extends Error {
  readonly code = "agent_vm_cap";
  readonly cap: number;
  readonly ownerKey: string;

  constructor(cap: number, ownerKey: string) {
    super(
      `Agent VM cap reached (${cap} live agent VMs): cannot start a VM for ${ownerKey}. ` +
        "Stop an idle agent VM or raise SWARM_VM_MAX_AGENT_VMS.",
    );
    this.name = "AgentVmCapError";
    this.cap = cap;
    this.ownerKey = ownerKey;
  }
}

/** One live allocation: which agent owns which container. */
export interface AgentVmAllocation {
  userId: string;
  agentId: string;
  /** VmManager owner key (plain userId for A1, `agent:<id>:<userId>` otherwise). */
  ownerKey: string;
  /** Container name the driver created for this agent's VM. */
  containerName: string;
  /** Epoch ms of the first allocate() for this agent. */
  allocatedAt: number;
  /** Epoch ms of the agent's most recent task start. */
  lastTaskAt: number;
}

/** Result of allocating (or reusing) an agent VM. */
export interface AgentVmAllocateResult {
  handle: VmHandle;
  ownerKey: string;
  containerName: string;
  /** True when the agent's VM was already live and reused (no new container). */
  reused: boolean;
}

/** Result of starting a task on an agent VM. */
export interface AgentVmStartTaskResult extends AgentVmAllocateResult {
  /** True when the VM was reset (destroyed + volume wiped) for a fresh task. */
  reset: boolean;
}

export interface AgentVmAllocatorOptions {
  /** Cap on concurrently live agent VMs (0/negative disables). Env/default when omitted. */
  maxAgentVms?: number;
  /** Idle minutes before reapIdle stops an agent VM (0 disables). Env/default when omitted. */
  idleReapMinutes?: number;
  /** Injectable clock — tests drive it with a fake timer. */
  now?: () => number;
}

/**
 * Per-agent VM allocation on top of a VmManager.
 *
 * The manager already keys every VM by an owner string and already
 * isolates owners (distinct container/volume/label, per-owner locks and
 * quotas, per-owner idle tracking). The allocator is the agent-shaped
 * layer over it: it derives the owner key from (userId, agentId), enforces
 * the concurrent-VM cap, applies the persistence toggle at task
 * boundaries, and reaps idle agent VMs.
 *
 * The allocation registry is in-memory (like the manager's handle cache):
 * a process restart forgets it, and the owner keys are re-derived
 * deterministically from (userId, agentId) on the next allocate — the
 * docker containers and volumes themselves survive, so nothing is lost.
 */
export class AgentVmAllocator {
  readonly manager: VmManager;
  readonly config: AgentVmConfig;
  private readonly now: () => number;
  private readonly allocations = new Map<string, AgentVmAllocation>();

  constructor(manager: VmManager, opts?: AgentVmAllocatorOptions) {
    this.manager = manager;
    this.config = resolveAgentVmConfig(
      { maxAgentVms: opts?.maxAgentVms, idleReapMinutes: opts?.idleReapMinutes },
      process.env,
    );
    this.now = opts?.now ?? Date.now;
  }

  /** Owner key for (userId, agentId) — validates the agent id. */
  ownerKeyFor(userId: string, agentId: string = DEFAULT_AGENT_ID): string {
    return agentOwnerKey(userId, agentId);
  }

  /** The allocation record for an agent, if this process allocated one. */
  allocationFor(userId: string, agentId: string = DEFAULT_AGENT_ID): AgentVmAllocation | undefined {
    const record = this.allocations.get(agentOwnerKey(userId, agentId));
    return record ? { ...record } : undefined;
  }

  /** All allocations this process knows about, oldest first. */
  listAllocations(): AgentVmAllocation[] {
    return [...this.allocations.values()]
      .sort((a, b) => a.allocatedAt - b.allocatedAt)
      .map((record) => ({ ...record }));
  }

  /** True when the agent's VM is live in this process (ensured, not stopped/reset). */
  isAgentVmLive(userId: string, agentId: string = DEFAULT_AGENT_ID): boolean {
    return this.manager.isVmLive(agentOwnerKey(userId, agentId));
  }

  /**
   * How many named-agent VMs are live right now: the live owner keys with
   * the `agent:` prefix. A1's VMs count under the plain userId key and are
   * covered by the runtime's global VM cap (SWARM_MAX_CONCURRENT_VMS)
   * instead, so they never count here.
   */
  liveAgentVmCount(): number {
    let count = 0;
    for (const ownerKey of this.manager.liveVmUserIds()) {
      if (ownerKey.startsWith("agent:")) count++;
    }
    return count;
  }

  /**
   * Allocate (or reuse) the agent's VM. A live VM is reused; otherwise a
   * new one is ensured, subject to the concurrent cap. Idle agent VMs are
   * reaped first so a slot frees when one is available.
   */
  async allocate(
    userId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<AgentVmAllocateResult> {
    const ownerKey = agentOwnerKey(userId, agentId);
    if (this.manager.isVmLive(ownerKey)) {
      const handle = await this.manager.ensure(ownerKey);
      this.recordAllocation(userId, agentId, ownerKey, handle);
      return { handle, ownerKey, containerName: handle.containerName, reused: true };
    }
    // A slot may free by reaping an idle agent VM before refusing outright.
    try {
      await this.reapIdle();
    } catch (error) {
      console.error("[vm] agent VM reap before allocate failed:", error);
    }
    // The cap bounds named-agent VMs. A1's VM is a user VM governed by the
    // runtime's global cap (SWARM_MAX_CONCURRENT_VMS), never by this one.
    if (
      agentId !== DEFAULT_AGENT_ID &&
      this.config.maxAgentVms > 0 &&
      this.liveAgentVmCount() >= this.config.maxAgentVms
    ) {
      throw new AgentVmCapError(this.config.maxAgentVms, ownerKey);
    }
    const handle = await this.manager.ensure(ownerKey);
    this.recordAllocation(userId, agentId, ownerKey, handle);
    return { handle, ownerKey, containerName: handle.containerName, reused: false };
  }

  /**
   * Start a task on the agent's VM: allocate (or reuse) it, then apply the
   * persistence toggle — "fresh-per-task" resets the VM (destroy + wipe
   * volume) before the task starts, unless this is a fork seed (its
   * checkpoint workspace must survive; see shouldResetVmAtRunStart). A VM
   * that was never created needs no reset: a fresh container already is a
   * fresh task. Updates lastTaskAt so the reaper measures from task starts.
   */
  async startTask(
    userId: string,
    agentId: string = DEFAULT_AGENT_ID,
    opts?: { mode?: VmPersistenceMode; seedSnapshotLabel?: string },
  ): Promise<AgentVmStartTaskResult> {
    const ownerKey = agentOwnerKey(userId, agentId);
    const facts: VmStartFacts = { seedSnapshotLabel: opts?.seedSnapshotLabel };
    const mode = opts?.mode ?? "persistent";
    // Fresh-per-task always resets, even on the first task: the previous
    // contract (and its pinned test) resets unconditionally, and
    // VmManager.reset ensures the VM first, so a never-created VM is
    // created and then wiped — the task still starts clean.
    if (shouldResetVmAtRunStart(mode, facts)) {
      await this.manager.reset(ownerKey);
      const handle = await this.manager.ensure(ownerKey);
      this.recordAllocation(userId, agentId, ownerKey, handle);
      return { handle, ownerKey, containerName: handle.containerName, reused: false, reset: true };
    }
    const allocated = await this.allocate(userId, agentId);
    const record = this.allocations.get(ownerKey);
    if (record) record.lastTaskAt = this.now();
    return { ...allocated, reset: false };
  }

  /**
   * End a task on the agent's VM: "terminate-at-project-end" stops the VM
   * (compute terminated, volume kept) when the project has no work left.
   * Returns whether the VM was stopped.
   */
  async endTask(
    userId: string,
    agentId: string = DEFAULT_AGENT_ID,
    opts?: { mode?: VmPersistenceMode; hasRemainingWork?: boolean },
  ): Promise<{ stopped: boolean }> {
    const ownerKey = agentOwnerKey(userId, agentId);
    const facts: VmEndFacts = { hasRemainingWork: opts?.hasRemainingWork ?? false };
    if (!shouldStopVmAtRunEnd(opts?.mode ?? "persistent", facts)) return { stopped: false };
    if (!this.manager.isVmLive(ownerKey)) return { stopped: false };
    await this.manager.stop(ownerKey);
    return { stopped: true };
  }

  /** The agent's desktop viewer endpoint (null when the driver has no desktop mode). */
  desktopEndpoint(
    userId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<VmDesktopEndpoint | null> {
    return this.manager.desktopEndpoint(agentOwnerKey(userId, agentId));
  }

  /** Run a command inside the agent's VM (its owner key, its quotas). */
  exec(
    userId: string,
    agentId: string,
    cmd: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    return this.manager.exec(agentOwnerKey(userId, agentId), cmd, opts);
  }

  /** Stop the agent's VM (volume kept; the next task re-ensures it). */
  async stopAgent(userId: string, agentId: string = DEFAULT_AGENT_ID): Promise<void> {
    const ownerKey = agentOwnerKey(userId, agentId);
    if (!this.manager.isVmLive(ownerKey)) return;
    await this.manager.stop(ownerKey);
  }

  /**
   * Destroy the agent's VM and wipe its volume, forgetting the allocation.
   * No-op when the agent never had a VM in this process.
   */
  async destroyAgent(userId: string, agentId: string = DEFAULT_AGENT_ID): Promise<boolean> {
    const ownerKey = agentOwnerKey(userId, agentId);
    if (!this.manager.isVmLive(ownerKey) && !this.allocations.has(ownerKey)) return false;
    await this.manager.reset(ownerKey);
    this.allocations.delete(ownerKey);
    return true;
  }

  /**
   * Stop every agent VM idle past the configured window and return the
   * owner keys that were reaped. A VM is never reaped when it is flagged
   * always-on (24/7), has an exec in flight, or is not live — and a VM
   * this process never allocated is left to the manager's own idle
   * sweeper, which owns the same activity records. Reaping stops (never
   * destroys): the /workspace volume survives, so the next task for that
   * agent re-ensures the same files.
   */
  async reapIdle(now: number = this.now()): Promise<string[]> {
    const idleMs = Math.round(this.config.idleReapMinutes * 60_000);
    if (idleMs <= 0) return [];
    const reaped: string[] = [];
    for (const record of [...this.allocations.values()]) {
      const ownerKey = record.ownerKey;
      if (!this.manager.isVmLive(ownerKey)) {
        this.allocations.delete(ownerKey);
        continue;
      }
      if (this.manager.isAlwaysOn(ownerKey)) continue;
      if (this.manager.hasActiveExec(ownerKey)) continue;
      const lastActivity = this.manager.lastActivityAt(ownerKey) ?? record.lastTaskAt;
      if (now - lastActivity < idleMs) continue;
      try {
        await this.manager.stop(ownerKey);
      } catch (error) {
        console.error(`[vm] failed to reap idle agent VM for ${ownerKey}:`, error);
        continue;
      }
      this.allocations.delete(ownerKey);
      reaped.push(ownerKey);
    }
    return reaped;
  }

  private recordAllocation(
    userId: string,
    agentId: string,
    ownerKey: string,
    handle: VmHandle,
  ): void {
    const existing = this.allocations.get(ownerKey);
    const at = this.now();
    if (existing) {
      existing.lastTaskAt = at;
      existing.containerName = handle.containerName;
      return;
    }
    this.allocations.set(ownerKey, {
      userId,
      agentId,
      ownerKey,
      containerName: handle.containerName,
      allocatedAt: at,
      lastTaskAt: at,
    });
  }
}

/** Container name for an agent's VM (via the docker driver's naming). */
export function containerNameForAgent(userId: string, agentId: string = DEFAULT_AGENT_ID): string {
  return containerNameFor(agentOwnerKey(userId, agentId));
}
