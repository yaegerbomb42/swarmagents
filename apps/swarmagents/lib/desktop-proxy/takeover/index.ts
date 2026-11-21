export { TakeoverStateMachine, StateTransitionError, type TransitionEvent, type TransitionListener } from "./state-machine";
export { computeDamageRegions, type DamageRegion, type DiffResult } from "./diff";
export { KeyframeStore, type KeyframeStoreOptions, type StoredKeyframe } from "./keyframe-store";
export {
  HandbackSummarizer,
  defaultFrameCaptioner,
  estimateTokens,
  truncateToTokenBudget,
  type FrameCaptioner,
  type HandbackSummarizerOptions,
  type WindowTitleProvider,
} from "./handback-summarizer";
export type {
  CaptionFrame,
  ControlState,
  HandbackSummary,
  InputEvent,
  KeyframeMeta,
} from "./types";
