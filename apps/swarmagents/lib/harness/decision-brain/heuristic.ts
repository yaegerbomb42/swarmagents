/**
 * Heuristic (no-network) decision router: the default scorer for the
 * Decision Brain until a local-model transport is decided (see
 * hidden_files/brain-wiring-decision.md). It never calls a model, so
 * the hook set stays testable and the eval harness stays runnable.
 *
 * The rules are deliberately conservative: the heuristic can only
 * escalate to a human (ask), signal a retry, or stop on budget
 * exhaustion. It never claims verification passed and never stops a
 * run for any other reason — judging completion needs a model.
 */
import { detectHighStakesReason } from "./router";
import { truncateReasonToTwelveWords } from "./schema";
import type { DecisionLogger } from "./logger";
import type {
  AgentSnapshot,
  DecisionResult,
  DecisionRouter,
} from "./types";

export interface HeuristicDecisionRouterOptions {
  logger?: DecisionLogger;
  now?: () => number;
}

export class HeuristicDecisionRouter implements DecisionRouter {
  private readonly logger?: DecisionLogger;
  private readonly now: () => number;

  constructor(options: HeuristicDecisionRouterOptions = {}) {
    this.logger = options.logger;
    this.now = options.now ?? (() => performance.now());
  }

  async decide(snapshot: AgentSnapshot): Promise<DecisionResult> {
    const started = this.now();
    let result: DecisionResult;

    const highStakes = detectHighStakesReason(snapshot);
    if (highStakes) {
      result = {
        decision: "ask",
        confidence: 1,
        reason: truncateReasonToTwelveWords(highStakes),
        escalated: false,
      };
    } else if (snapshot.budgetLeft.turnsRemaining <= 0) {
      result = {
        decision: "stop",
        confidence: 1,
        reason: "turn budget exhausted",
        escalated: false,
      };
    } else if (snapshot.error !== null) {
      result = {
        decision: "retry",
        confidence: 0.8,
        reason: "last step failed",
        escalated: false,
      };
    } else {
      result = {
        decision: "continue",
        confidence: 0.6,
        reason: "no signal to intervene",
        escalated: false,
      };
    }

    if (this.logger) {
      await this.logger.log({
        timestamp: new Date().toISOString(),
        turnCount: snapshot.turnCount,
        decision: result.decision,
        confidence: result.confidence,
        reason: result.reason,
        escalated: result.escalated,
        escalationReason: null,
        localModel: "heuristic",
        bigModel: "heuristic",
        latencyMs: Number((this.now() - started).toFixed(2)),
      });
    }
    return result;
  }
}
