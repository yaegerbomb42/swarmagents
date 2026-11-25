/**
 * Adaptive Trajectory Context Optimizer (lib/harness/context/trajectory-manager.ts).
 *
 * Unifies SwarmAgents' existing token-efficiency primitives:
 *   - condenseLog (log-condenser.ts) to compress noisy shell/build logs
 *   - StateLedger + fitText + ContextGovernor (contextGovernor.ts) to externalize progress & evict dead attempts
 *   - SourceFile / WorkingSetItem (astSlicer.ts) to ship AST skeletons + line windows
 *
 * Designed for very long (20–500+ turn) trajectories where unbounded append
 * causes context collapse and unnecessary token burn.
 */

import { estimateTokens } from "../../codebase/tokens";
import { condenseLog } from "../log-condenser";
import type { SourceFile, WorkingSetItem } from "./astSlicer";
import { ContextGovernor, StateLedger, fitText, type L1Budget, type PackedTurn } from "./contextGovernor";

export interface CondensedOutputResult {
  text: string;
  rawTokens: number;
  condensedTokens: number;
  tokensSaved: number;
  wasCondensed: boolean;
}

export interface TrajectoryStats {
  turnsProcessed: number;
  rawTokensObserved: number;
  tokensSavedByCondenser: number;
}

export class TrajectoryOptimizer {
  readonly ledger: StateLedger;
  private turnsProcessed = 0;
  private rawTokensObserved = 0;
  private tokensSavedByCondenser = 0;

  constructor(goal: string, constraints: string[] = []) {
    this.ledger = new StateLedger(goal, { constraints });
  }

  /**
   * Compress noisy build/test tool output while preserving failure diagnostics.
   * Logs under 1,200 chars pass through verbatim; larger outputs run through
   * `condenseLog` and accumulate token-savings telemetry.
   */
  condenseToolOutput(rawOutput: string, maxChars = 6000): CondensedOutputResult {
    const rawTokens = estimateTokens(rawOutput);
    this.rawTokensObserved += rawTokens;
    if (rawOutput.length <= 1200) {
      return {
        text: rawOutput,
        rawTokens,
        condensedTokens: rawTokens,
        tokensSaved: 0,
        wasCondensed: false,
      };
    }
    const text = condenseLog(rawOutput, { maxChars });
    const condensedTokens = estimateTokens(text);
    const tokensSaved = Math.max(0, rawTokens - condensedTokens);
    this.tokensSavedByCondenser += tokensSaved;
    return {
      text,
      rawTokens,
      condensedTokens,
      tokensSaved,
      wasCondensed: text.length < rawOutput.length,
    };
  }

  recordTurn(input: {
    stepSummary?: string;
    failedAttempt?: { tried: string; failedBecause: string; doNotRetry: string };
    errorOutput?: string;
  }): void {
    this.turnsProcessed += 1;
    if (input.stepSummary) {
      this.ledger.recordStep(this.turnsProcessed, fitText(input.stepSummary, 120, "head"));
    }
    if (input.failedAttempt) {
      this.ledger.recordFailedAttempt(
        fitText(input.failedAttempt.tried, 80, "head"),
        fitText(input.failedAttempt.failedBecause, 120, "head"),
        fitText(input.failedAttempt.doNotRetry, 80, "head"),
        this.turnsProcessed,
      );
    }
    if (input.errorOutput !== undefined) {
      const condensed = this.condenseToolOutput(input.errorOutput, 3000);
      this.ledger.setError(condensed.text);
    }
  }

  /**
   * Build a bounded L1 AST-sliced continuation packet for very long trajectories
   * or cross-phase role switches without replaying unbounded raw transcripts.
   */
  buildContinuationPacket(input: {
    files?: SourceFile[];
    workingSet?: WorkingSetItem[];
    systemExtras?: string[];
    budget?: Partial<L1Budget>;
  }): PackedTurn {
    const governor = new ContextGovernor({ budget: input.budget });
    return governor.pack({
      turn: Math.max(1, this.turnsProcessed),
      ledger: this.ledger,
      skeletonFiles: input.files ?? [],
      workingSet: input.workingSet ?? [],
      systemExtras: input.systemExtras,
    });
  }

  stats(): TrajectoryStats {
    return {
      turnsProcessed: this.turnsProcessed,
      rawTokensObserved: this.rawTokensObserved,
      tokensSavedByCondenser: this.tokensSavedByCondenser,
    };
  }
}
