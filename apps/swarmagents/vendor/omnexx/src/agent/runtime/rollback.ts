import type { Message } from '../../providers/types.js';
import type { GitTreeSnapshotter, Snapshot } from './checkpoint.js';

export interface RollbackOptions {
  /** Maximum number of speculative rollbacks permitted per agent run (default: 2). */
  maxRollbacksPerRun?: number;
}

export interface RollbackCheckpoint {
  turnIndex: number;
  snapshot: Snapshot;
  messageCount: number;
}

export interface RollbackExecutionResult {
  rolledBack: boolean;
  restoredMessageCount: number;
  interventionMessage?: Message;
  reason?: string;
}

/**
 * Speculative Branch Rollback Manager (Step 3.7)
 *
 * Automatically captures isolated throwaway Git checkpoints before risky mutation/bash turns.
 * When stuck loops, fatal test regressions, or unrecoverable syntax breakages occur, resets the
 * filesystem to pre-mutation state and injects a structured system intervention lesson.
 */
export class SpeculativeBranchRollbackManager {
  private checkpoints: RollbackCheckpoint[] = [];
  private rollbackCount = 0;
  private readonly maxRollbacks: number;

  constructor(
    private readonly snapshotter: GitTreeSnapshotter,
    options: RollbackOptions = {},
  ) {
    this.maxRollbacks = options.maxRollbacksPerRun ?? 2;
  }

  get remainingRollbacks(): number {
    return Math.max(0, this.maxRollbacks - this.rollbackCount);
  }

  get hasActiveCheckpoint(): boolean {
    return this.checkpoints.length > 0;
  }

  /**
   * Arm a checkpoint prior to executing a risky mutation or bash turn.
   */
  async armCheckpoint(
    turnIndex: number,
    currentMessages: readonly Message[],
  ): Promise<RollbackCheckpoint> {
    const snapshot = await this.snapshotter.snapshot();
    const cp: RollbackCheckpoint = {
      turnIndex,
      snapshot,
      messageCount: currentMessages.length,
    };
    this.checkpoints.push(cp);
    return cp;
  }

  /**
   * Disarm latest checkpoint when turn verification succeeds.
   */
  disarmLatest(): void {
    this.checkpoints.pop();
  }

  /**
   * Execute speculative rollback if failure or dead-end detected.
   */
  async executeRollback(
    messages: Message[],
    failureReason: string,
  ): Promise<RollbackExecutionResult> {
    const cp = this.checkpoints.pop();
    if (!cp) {
      return {
        rolledBack: false,
        restoredMessageCount: messages.length,
        reason: 'No active checkpoint to restore',
      };
    }

    if (this.rollbackCount >= this.maxRollbacks) {
      return {
        rolledBack: false,
        restoredMessageCount: messages.length,
        reason: `Max rollbacks (${String(this.maxRollbacks)}) exceeded`,
      };
    }

    // 1. Restore workspace files to snapshot ref
    await this.snapshotter.restore(cp.snapshot);
    this.rollbackCount++;

    // 2. Truncate conversation history back to checkpoint message count
    messages.length = cp.messageCount;

    // 3. Inject structured system intervention lesson
    const interventionMessage: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system_intervention type="branch_rollback">\nSpeculative execution failed at turn ${String(cp.turnIndex)}: ${failureReason}\nWorkspace files have been restored to pre-mutation state. Formulate an alternative approach and do not repeat the failed hypothesis.\n</system_intervention>`,
        },
      ],
    };
    messages.push(interventionMessage);

    return {
      rolledBack: true,
      restoredMessageCount: messages.length,
      interventionMessage,
    };
  }
}
