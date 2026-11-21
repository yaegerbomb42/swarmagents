export { DecisionBrainHooks, type BrainEvent, type BrainVerdict, type DecisionBrainHooksOptions } from "./hooks";
export {
  DEFAULT_DECISION_BRAIN_SETTINGS,
  resolveDecisionBrainSettings,
  type DecisionBrainSettings,
  type DecisionBrainSettingsInput,
} from "./settings";
export { HeuristicDecisionRouter, type HeuristicDecisionRouterOptions } from "./heuristic";
export { LocalEscalatingRouter, detectHighStakesReason, type LocalEscalatingRouterOptions } from "./router";
export { DecisionLogger } from "./logger";
export { evaluateDecisionRouter, type ModelEvalReport } from "./eval";
export { generateSyntheticDataset } from "./synthetic";
export type {
  AgentSnapshot,
  BudgetSnapshot,
  DecisionKind,
  DecisionLogEntry,
  DecisionResult,
  DecisionRouter,
  ModelEndpointConfig,
  SyntheticDecisionSample,
  ToolCallSnapshot,
  ToolResultSnapshot,
} from "./types";
