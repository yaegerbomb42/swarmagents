// Public API of the runtime control plane.
//
// Import from "@/lib/runtime" everywhere. The agent core should import only
// `setAgentAdapter` and the recorder hooks it needs; the UI/API imports the rest.

export * from "./types";
export {
  createTask,
  listTasks,
  getTask,
  updateTask,
  setStatus,
  finishTask,
  waitTask,
  cancelTask,
  deleteTask,
  dueTasks,
  runningTasks,
  runnableTasks,
  progressOf,
  subscribeRuntime,
  type RuntimeEvent,
  type CreateTaskInput,
} from "./tasks";
export {
  addStep,
  startRun,
  recordTurn,
  recordTool,
  noteRun,
  endRun,
  getLedger,
  checkBudget,
  summarizeUsage,
  fmtDuration,
  type BudgetCheck,
} from "./ledger";
export {
  registerArtifact,
  listArtifacts,
  getArtifact,
  setKept,
  deleteArtifact,
  fmtSize,
} from "./artifacts";
export {
  setAgentAdapter,
  getAgentAdapter,
  requireAdapter,
  NoAdapterError,
  type AgentAdapter,
  type RunHooks,
  type RunOutcome,
} from "./resume";
export { scheduler } from "./scheduler";
export { bootstrapRuntime } from "./bootstrap";
export { loadRuntimeSettings, saveRuntimeSettings, RUNTIME_DIR } from "./store";