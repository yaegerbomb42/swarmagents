import { MiniOrchestrator } from "./orchestrator.js";
import { SafetySnapshot } from "./safetySnapshot.js";
import { AstSlicer } from "./astSlicer.js";
import * as path from "path";

export interface AutoLoopResult {
  success: boolean;
  iterations: number;
  tokensUsed: number;
  filesModified: string[];
  finalOutput: string;
}

export class AutoRepairLoop {
  private orchestrator: MiniOrchestrator;
  private snapshotManager: SafetySnapshot;
  private maxRetries: number;

  constructor(orchestrator?: MiniOrchestrator, maxRetries: number = 4) {
    this.orchestrator = orchestrator || new MiniOrchestrator();
    this.snapshotManager = new SafetySnapshot();
    this.maxRetries = maxRetries;
  }

  /**
   * Automatically executes a verification command (e.g. `npm test` or `tsc --noEmit`),
   * parses failures, patches the target file, and loops until exit code 0 or maxRetries.
   * If a patch fails or introduces worse errors, rolls back automatically.
   */
  public async autoRepairUntilPassing(
    filePath: string,
    verifyCommand: string,
    targetStartLine: number = 1,
    targetEndLine: number = 100
  ): Promise<AutoLoopResult> {
    console.log(`[AutoRepairLoop] Starting autonomous loop for ${path.basename(filePath)}...`);
    console.log(`[AutoRepairLoop] Verification command: "${verifyCommand}"`);

    let iteration = 0;
    let totalTokens = 0;
    const modifiedFiles: Set<string> = new Set();

    while (iteration < this.maxRetries) {
      iteration++;
      console.log(`\n--- Iteration ${iteration} of ${this.maxRetries} ---`);

      // 1. Run check
      const check = await this.orchestrator.runCommand(verifyCommand);
      if (check.success) {
        console.log(`[AutoRepairLoop] 🎉 Verification PASSED on iteration ${iteration}!`);
        this.snapshotManager.commit(filePath);
        return {
          success: true,
          iterations: iteration,
          tokensUsed: totalTokens,
          filesModified: Array.from(modifiedFiles),
          finalOutput: check.output,
        };
      }

      console.log(`[AutoRepairLoop] Check failed. Diagnostic error condensed to ${check.output.length} chars.`);

      // 2. Snapshot file before edit
      this.snapshotManager.snapshot(filePath);

      // 3. Execute atomic 8k repair turn
      const turn = await this.orchestrator.executeFileRepairTurn(
        filePath,
        check.output,
        targetStartLine,
        targetEndLine
      );

      totalTokens += turn.tokensUsed;

      if (!turn.success) {
        console.warn(`[AutoRepairLoop] Repair turn failed: ${turn.message}. Rolling back.`);
        this.snapshotManager.rollback(filePath);
        continue;
      }

      modifiedFiles.add(filePath);

      // 4. Test again to see if we improved or degraded
      const reCheck = await this.orchestrator.runCommand(verifyCommand);
      if (reCheck.success) {
        console.log(`[AutoRepairLoop] 🎉 Fix successful! Clean exit 0 verified.`);
        this.snapshotManager.commit(filePath);
        return {
          success: true,
          iterations: iteration,
          tokensUsed: totalTokens,
          filesModified: Array.from(modifiedFiles),
          finalOutput: reCheck.output,
        };
      }

      console.log(`[AutoRepairLoop] Still failing. Feeding updated diagnostic into next turn...`);
    }

    // If max retries reached and still failing, rollback to clean state
    console.warn(`[AutoRepairLoop] ⚠️ Max retries reached without 100% clean check. Rolling back.`);
    this.snapshotManager.rollback(filePath);

    return {
      success: false,
      iterations: iteration,
      tokensUsed: totalTokens,
      filesModified: [],
      finalOutput: "Max retries exceeded.",
    };
  }
}
