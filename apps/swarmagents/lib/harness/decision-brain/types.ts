export type DecisionKind = "continue" | "retry" | "ask" | "verify" | "stop";

export interface ToolCallSnapshot {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultSnapshot {
  ok: boolean;
  output: string;
}

export interface BudgetSnapshot {
  turnsRemaining: number;
  tokensRemaining: number;
  costUsdRemaining?: number;
}

export interface AgentSnapshot {
  goal: string;
  lastToolCall: ToolCallSnapshot | null;
  lastToolResult: ToolResultSnapshot | null;
  error: string | null;
  turnCount: number;
  budgetLeft: BudgetSnapshot;
}

export interface DecisionResult {
  decision: DecisionKind;
  confidence: number;
  reason: string;
  escalated: boolean;
}

export interface DecisionRouter {
  decide(snapshot: AgentSnapshot): Promise<DecisionResult>;
}

export interface DecisionLogEntry {
  timestamp: string;
  turnCount: number;
  decision: DecisionKind;
  confidence: number;
  reason: string;
  escalated: boolean;
  escalationReason: string | null;
  localModel: string;
  bigModel: string;
  latencyMs: number;
}

export interface ModelEndpointConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface SyntheticDecisionSample {
  id: string;
  synthetic: true;
  source: "synthetic-generator-v1";
  category: string;
  snapshot: AgentSnapshot;
  expectedDecision: DecisionKind;
  expectedHighStakes: boolean;
}
