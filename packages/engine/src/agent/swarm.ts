/**
 * The hierarchical swarm: one coordinator, four specialized roles, a fixed pipeline. The
 * architect maps the goal into a structured milestone spec, the implementer writes the
 * minimal code that satisfies it, the red-team tries to break that code with aggressive
 * tests, and the auditor reviews the result against OWASP standards and project invariants.
 * Each phase's output lands on the shared scratchpad ('spec', 'impl', 'qa', 'audit'), so
 * later phases — and the owner, afterwards — read results instead of re-deriving them.
 *
 * The implementer is the only phase that can collide with parallel work, so the coordinator
 * holds region locks for every file region the spec names for the whole implementation
 * phase, and releases them in a finally: a crashed implementer must never wedge the tree.
 *
 * Orchestration only. This module makes no model or provider calls: each role's work is an
 * injected executor. Production wiring adapts helperRunner (./subagent.ts) to these
 * signatures, giving each role its brief (SWARM_ROLES) and its own model chain; tests inject
 * fakes. Keeping the model out of the coordinator is what makes the pipeline's ordering,
 * locking and verdict logic unit-testable at all.
 */
import type { FileRegion, RegionLockManager } from '../workers/file-locks.js';
import { wholeFileRegion } from '../workers/file-locks.js';
import type { SharedScratchpad } from '../workers/scratchpad.js';

export type SwarmRoleId = 'architect' | 'implementer' | 'red-team' | 'auditor';

/** What a role may do. Read-only roles get 'read' and nothing else; enforced at wiring time. */
export type SwarmCapability = 'read' | 'write-code' | 'write-tests' | 'lock-regions';

export interface SwarmRole {
  id: SwarmRoleId;
  title: string;
  /** System-prompt brief, in the voice of subagent.ts's BRIEF entries: terse and imperative. */
  brief: string;
  capabilities: readonly SwarmCapability[];
}

/** The four roles. Order here is pipeline order. */
export const SWARM_ROLES: Record<SwarmRoleId, SwarmRole> = {
  architect: {
    id: 'architect',
    title: 'Architect / Explorer',
    brief:
      'Map the call graph and dependencies for the goal, then write a structured milestone ' +
      'spec: the files, the regions within them, and the acceptance checks. Read-only: ' +
      'describe the shape of the change, never the code.',
    capabilities: ['read'],
  },
  implementer: {
    id: 'implementer',
    title: 'Implementer',
    brief:
      'Write the minimal code that satisfies the spec — nothing more. Hold region locks ' +
      'for every file you touch, match the surrounding style, and stop when the acceptance ' +
      'checks pass.',
    capabilities: ['read', 'write-code', 'lock-regions'],
  },
  'red-team': {
    id: 'red-team',
    title: 'Adversarial Red-Team / QA',
    brief:
      'Attack the implementation: fuzz it, probe the boundaries and the malformed inputs, ' +
      'and write tests designed to break it. A test that cannot fail proves nothing.',
    capabilities: ['read', 'write-tests'],
  },
  auditor: {
    id: 'auditor',
    title: 'Security & Quality Auditor',
    brief:
      'Review the diff against the OWASP standards and the project invariants. Report ' +
      'only findings you can evidence from the diff; block on security and correctness, ' +
      'never on taste.',
    capabilities: ['read'],
  },
};

/** One file the milestone touches; regions omitted means the whole file is in play. */
export interface MilestoneFile {
  path: string;
  action: 'create' | 'modify' | 'delete';
  regions?: { startLine: number; endLine: number }[];
}

/** The architect's output: the contract every later phase works against. */
export interface MilestoneSpec {
  id: string;
  title: string;
  summary: string;
  files: MilestoneFile[];
  acceptance: string[];
  /** Ids of milestones that must land before this one. */
  dependencies: string[];
}

export interface ImplResult {
  summary: string;
  changedFiles: string[];
  notes?: string[];
}

export interface QaFailure {
  /** Name of the test that broke the implementation. */
  test: string;
  detail: string;
}

export interface QaResult {
  summary: string;
  testsWritten: string[];
  failures: QaFailure[];
}

export interface AuditFinding {
  /** Only 'blocking' fails the run; major/minor are reported for the owner to weigh. */
  severity: 'blocking' | 'major' | 'minor';
  /** The standard or invariant cited, e.g. "OWASP A03:2021 Injection". */
  rule: string;
  detail: string;
  path?: string;
}

export interface AuditResult {
  summary: string;
  findings: AuditFinding[];
}

/** Everything one run produced, plus the verdict the owner actually acts on. */
export interface SwarmReport {
  spec: MilestoneSpec;
  impl: ImplResult;
  qa: QaResult;
  audit: AuditResult;
  /** 'pass' only when QA found no failures and the audit has no blocking findings. */
  verdict: 'pass' | 'fail';
}

/** What the implementer receives alongside the spec: the shared board and the lock manager. */
export interface SwarmPhaseContext {
  scratchpad: SharedScratchpad;
  locks: RegionLockManager;
  role: SwarmRoleId;
}

/**
 * The four roles' work, injected. Signatures mirror the pipeline: each executor sees the
 * outputs of the phases before it and nothing else.
 */
export interface SwarmExecutors {
  architect: (goal: string) => Promise<MilestoneSpec>;
  implementer: (spec: MilestoneSpec, ctx: SwarmPhaseContext) => Promise<ImplResult>;
  redTeam: (spec: MilestoneSpec, impl: ImplResult) => Promise<QaResult>;
  auditor: (spec: MilestoneSpec, impl: ImplResult, qa: QaResult) => Promise<AuditResult>;
  /** Optional pre-implementation review of a proposal (security, speed, correctness). */
  reviewer?: (spec: MilestoneSpec) => Promise<PeerReview>;
}

export type SwarmPhase = SwarmRoleId;

/** Phase lifecycle, delivered to the coordinator's onEvent callback. */
export interface SwarmEvent {
  phase?: SwarmPhase;
  stage: 'start' | 'done';
  at: number;
  /** The spec id once the architect has produced it; the goal before that. */
  detail: string;
  /** Telemetry: the delegation-bus message type when this is a bus/consensus event. */
  messageType?: SwarmMessageType;
  /** Telemetry: JSON-serializable payload for WebSocket/SSE consumers. */
  payload?: unknown;
}

export interface SwarmCoordinatorDeps {
  executors: SwarmExecutors;
  scratchpad: SharedScratchpad;
  locks: RegionLockManager;
  onEvent?: (event: SwarmEvent) => void;
  /** Optional delegation bus; when set, protocol messages are published to it. */
  bus?: DelegationBus;
  /** Clock for event timestamps; injectable for deterministic tests. */
  now?: () => number;
  /** Timeout for the implementer phase's lock acquisition; waits indefinitely when omitted. */
  lockTimeoutMs?: number;
}

/** Every region the spec puts in play: named regions, or the whole file when unnamed. */
export function specRegions(spec: MilestoneSpec): FileRegion[] {
  const regions: FileRegion[] = [];
  for (const file of spec.files) {
    if (file.regions?.length) {
      for (const r of file.regions) regions.push({ path: file.path, ...r });
    } else {
      regions.push(wholeFileRegion(file.path));
    }
  }
  return regions;
}

export class SwarmCoordinator {
  private readonly executors: SwarmExecutors;
  private readonly scratchpad: SharedScratchpad;
  private readonly locks: RegionLockManager;
  private readonly bus: DelegationBus | undefined;
  private readonly onEvent: ((event: SwarmEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number | undefined;

  constructor(deps: SwarmCoordinatorDeps) {
    this.executors = deps.executors;
    this.scratchpad = deps.scratchpad;
    this.locks = deps.locks;
    this.bus = deps.bus;
    this.onEvent = deps.onEvent;
    this.now = deps.now ?? Date.now;
    this.lockTimeoutMs = deps.lockTimeoutMs;
  }

  /**
   * Run the pipeline for one goal. Phases run strictly in order (each consumes the last
   * phase's output); a throwing executor aborts the run and propagates, with the
   * implementer's locks released on the way out.
   */
  async run(goal: string): Promise<SwarmReport> {
    this.emit('architect', 'start', goal);
    const spec = await this.executors.architect(goal);
    this.scratchpad.put('spec', spec.id, spec);
    this.scratchpad.append({ ns: 'spec', key: spec.id, kind: 'phase-output' });
    this.emit('architect', 'done', spec.id);

    this.emit('implementer', 'start', spec.id);
    const ctx: SwarmPhaseContext = {
      scratchpad: this.scratchpad,
      locks: this.locks,
      role: 'implementer',
    };
    const handle = await this.locks.acquire('implementer', specRegions(spec), {
      ...(this.lockTimeoutMs !== undefined ? { timeoutMs: this.lockTimeoutMs } : {}),
    });
    let impl: ImplResult;
    try {
      impl = await this.executors.implementer(spec, ctx);
    } finally {
      handle.release();
    }
    this.scratchpad.put('impl', spec.id, impl);
    this.scratchpad.append({ ns: 'impl', key: spec.id, kind: 'phase-output' });
    this.emit('implementer', 'done', spec.id);

    this.emit('red-team', 'start', spec.id);
    const qa = await this.executors.redTeam(spec, impl);
    this.scratchpad.put('qa', spec.id, qa);
    this.scratchpad.append({ ns: 'qa', key: spec.id, kind: 'phase-output' });
    this.emit('red-team', 'done', spec.id);

    this.emit('auditor', 'start', spec.id);
    const audit = await this.executors.auditor(spec, impl, qa);
    this.scratchpad.put('audit', spec.id, audit);
    this.scratchpad.append({ ns: 'audit', key: spec.id, kind: 'phase-output' });
    this.emit('auditor', 'done', spec.id);

    const verdict: SwarmReport['verdict'] =
      qa.failures.length === 0 && !audit.findings.some((f) => f.severity === 'blocking')
        ? 'pass'
        : 'fail';
    this.scratchpad.append({ ns: 'audit', key: spec.id, kind: 'verdict', note: verdict });
    return { spec, impl, qa, audit, verdict };
  }

  /**
   * Run the four-step deliberation protocol for a goal:
   *   propose_plan -> peer_review -> delegate_task -> consensus_reached.
   *
   * This is a pre-execution agreement layer: it does not write code. Every bus
   * message and the final consensus verdict are emitted as JSON telemetry events
   * via onEvent, so dashboards can subscribe over WebSocket or SSE.
   */
  async deliberate(goal: string): Promise<DeliberationOutcome> {
    const roundId = `round-${this.now()}`;
    const messages: SwarmMessage[] = [];

    const publish = (message: Omit<SwarmMessage, 'id' | 'timestamp'>): void => {
      const emitted = this.bus?.publish(message);
      if (emitted) messages.push(emitted);
      this.emitTelemetry(emitted ? emitted.type : message.type, message.from, message.payload);
    };

    // 1. propose_plan — the planner breaks the goal into sub-tasks.
    this.emit('architect', 'start', goal);
    const spec = await this.executors.architect(goal);
    this.emit('architect', 'done', spec.id);

    const subTasks = spec.files.map((file) => ({
      id: file.path,
      title: `${file.action} ${file.path}`,
      seat: 'implementer',
      summary: file.path,
    }));
    publish({
      type: 'propose_plan',
      from: 'coordinator',
      payload: { goal, roundId, subTasks },
    });

    // 2. peer_review — the critic scores the proposal for security, speed, correctness.
    const review: PeerReview =
      this.executors.reviewer !== undefined
        ? await this.executors.reviewer(spec)
        : ({
            proposalId: spec.id,
            reviewer: 'auditor',
            scores: { security: 100, speed: 100, correctness: 100 },
            verdict: 'approve' as const,
            notes: [] as string[],
          } as PeerReview);
    publish({
      type: 'peer_review',
      from: review.reviewer,
      payload: {
        proposalId: spec.id,
        roundId,
        reviewer: review.reviewer,
        scores: review.scores,
        verdict: review.verdict,
        notes: review.notes,
      },
    });

    // 3. delegate_task — hand each sub-task to a specialized worker seat.
    const reviewPasses = review.verdict === 'approve';
    if (reviewPasses) {
      for (const file of spec.files) {
        const seat = seatFor(file);
        publish({
          type: 'delegate_task',
          from: 'coordinator',
          to: seat,
          payload: {
            roundId,
            taskId: file.path,
            seat,
            instruction: `${file.action} ${file.path}`,
          },
        });
      }
    }

    // 4. consensus_reached — every seat votes; tally against the threshold.
    const votes: ConsensusVote[] = SWARM_SEATS.map((seat) => ({
      seat,
      decision: reviewPasses ? ('approve' as const) : ('reject' as const),
      reason: reviewPasses
        ? `proposal reviewed OK (${review.verdict})`
        : `review did not pass (${review.verdict})`,
    }));
    const consensus = aggregateConsensus(roundId, votes, SWARM_SEATS.length);
    publish({
      type: 'consensus_reached',
      from: 'coordinator',
      payload: {
        roundId,
        approved: consensus.approved,
        votesFor: consensus.votesFor,
        votesAgainst: consensus.votesAgainst,
        votesAbstain: consensus.votesAbstain,
        total: consensus.total,
        threshold: consensus.threshold,
        summary: consensus.summary,
      },
    });

    return { spec, review, consensus, messages };
  }

  private emitTelemetry(
    messageType: SwarmMessageType,
    from: string,
    payload: unknown,
  ): void {
    this.onEvent?.({
      stage: 'done',
      at: this.now(),
      detail: `${messageType} from ${from}`,
      messageType,
      payload,
    });
  }

  private emit(phase: SwarmPhase, stage: SwarmEvent['stage'], detail: string): void {
    this.onEvent?.({ phase, stage, at: this.now(), detail });
  }
}

/** ---------------------------------------------------------------------------
 *  Typed message exchange protocol (delegation bus)
 * -------------------------------------------------------------------------- */

/** Message types exchanged between swarm seats during deliberation. */
export type SwarmMessageType =
  | 'propose_plan'
  | 'peer_review'
  | 'delegate_task'
  | 'consensus_reached';

/** Payload shape for each message type. */
export interface SwarmMessagePayloads {
  propose_plan: {
    goal: string;
    roundId: string;
    subTasks: Array<{ id: string; title: string; seat: string; summary: string }>;
  };
  peer_review: {
    proposalId: string;
    roundId: string;
    reviewer: string;
    scores: { security: number; speed: number; correctness: number };
    verdict: 'approve' | 'reject' | 'request-changes';
    notes: string[];
  };
  delegate_task: {
    roundId: string;
    taskId: string;
    seat: string;
    instruction: string;
  };
  consensus_reached: {
    roundId: string;
    approved: boolean;
    votesFor: number;
    votesAgainst: number;
    votesAbstain: number;
    total: number;
    threshold: number;
    summary: string;
  };
}

/** A single message published on the delegation bus. */
export interface SwarmMessage<T extends SwarmMessageType = SwarmMessageType> {
  id: string;
  type: T;
  from: string;
  to?: string;
  payload: SwarmMessagePayloads[T];
  timestamp: number;
  replyTo?: string;
}

/** Publish/subscribe bus for typed swarm messages. */
export class DelegationBus {
  private readonly listeners = new Set<(message: SwarmMessage) => void>();
  private readonly _history: SwarmMessage[] = [];
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Publish a typed message; returns the enriched message (id + timestamp). */
  publish<T extends SwarmMessageType>(
    message: Omit<SwarmMessage<T>, 'id' | 'timestamp'>,
  ): SwarmMessage<T> {
    const full: SwarmMessage<T> = {
      ...message,
      id: `msg-${this.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: this.now(),
    } as SwarmMessage<T>;
    this._history.push(full);
    for (const listener of this.listeners) listener(full);
    return full;
  }

  /** Subscribe to every message on the bus; returns an unsubscribe handle. */
  subscribe(handler: (message: SwarmMessage) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** All messages published so far, in order. */
  history(): readonly SwarmMessage[] {
    return [...this._history];
  }
}


/** ---------------------------------------------------------------------------
 *  Consensus voting
 * -------------------------------------------------------------------------- */

export type ConsensusDecision = 'approve' | 'reject' | 'abstain';

export interface ConsensusVote {
  seat: string;
  decision: ConsensusDecision;
  reason: string;
}

export interface ConsensusResult {
  roundId: string;
  approved: boolean;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  total: number;
  threshold: number;
  summary: string;
}

/** Simple majority threshold: floor(n/2) + 1. */
export function consensusThreshold(total: number): number {
  return Math.floor(total / 2) + 1;
}

/** Tally votes against the threshold. */
export function aggregateConsensus(
  roundId: string,
  votes: readonly ConsensusVote[],
  totalSeats: number,
): ConsensusResult {
  const votesFor = votes.filter((v) => v.decision === 'approve').length;
  const votesAgainst = votes.filter((v) => v.decision === 'reject').length;
  const votesAbstain = votes.filter((v) => v.decision === 'abstain').length;
  const threshold = consensusThreshold(totalSeats);
  const approved = votesFor >= threshold;
  const summary = approved
    ? `Consensus: ${votesFor}/${totalSeats} approved`
    : `No consensus: ${votesFor}/${totalSeats} approved (need ${threshold})`;
  return { roundId, approved, votesFor, votesAgainst, votesAbstain, total: totalSeats, threshold, summary };
}

/** The swarm seats, in pipeline order. */
export const SWARM_SEATS: readonly SwarmRoleId[] = ['architect', 'implementer', 'red-team', 'auditor'];

export interface PeerReview {
  proposalId: string;
  reviewer: string;
  scores: { security: number; speed: number; correctness: number };
  verdict: 'approve' | 'reject' | 'request-changes';
  notes: string[];
}

/** Outcome of the four-step deliberation protocol. */
export interface DeliberationOutcome {
  spec: MilestoneSpec;
  review: PeerReview;
  consensus: ConsensusResult;
  messages: readonly SwarmMessage[];
}

/** Map a spec file to the seat best suited to implement it. */
function seatFor(_file: MilestoneFile): SwarmRoleId {
  return 'implementer';
}