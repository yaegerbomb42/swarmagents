export type SandboxMode = 'shell' | 'browser' | 'edit' | 'mixed';

export type SandboxStatus = 'idle' | 'running' | 'paused' | 'error' | 'done';

export interface SandboxLogLine {
  ts: number;
  kind: 'stdout' | 'stderr' | 'tool' | 'nav' | 'info' | 'error';
  text: string;
}

export type SandboxActionType =
  | 'use_browser'
  | 'communicate'
  | 'spawn_subagent'
  | 'create_file'
  | 'think'
  | 'check_blackboard'
  | 'compress_context'
  | 'git_commit'
  | 'file_edit'
  | 'shell_exec'
  | 'web_search'
  | 'read_file'
  | 'hamiltonian_decide'
  | 'hamiltonian_rank_actions'
  | 'hamiltonian_feedback';

export interface SandboxActionParam {
  key: string;
  value: string;
}

export interface SandboxAction {
  id: string;
  ts: number; // unix ms timestamp
  type: SandboxActionType;
  label: string; // human-readable description
  params?: SandboxActionParam[]; // key-value params (editable in UI)
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  filePath?: string; // for file_edit/create_file actions
  diffLines?: string; // unified diff for file_edit
  targetX?: number; // for use_browser cursor
  targetY?: number; // for use_browser cursor
  elapsedMs?: number; // for think actions
}

export interface TelemetryEvent {
  type:
    | 'agent_update'
    | 'action_log'
    | 'token_count'
    | 'context_pct'
    | 'blackboard_update'
    | 'thought'
    | 'failover';
  agentId: string;
  payload: Partial<AgentSandbox> | SandboxAction | Record<string, unknown>;
  ts: number;
}

export interface AgentSandbox {
  id: string;
  agentId: string;
  nodeId: string;
  label: string;
  /** Leaf / task title under the role */
  taskLabel?: string;
  mode: SandboxMode;
  status: SandboxStatus;
  agentClass?: string;
  archetype?: string; // 'verifier' | 'researcher' | 'planner' | 'coder' | 'critic' | 'architect' etc
  model?: string; // full model name from BYOK fleet
  modelTier?: string;
  /** Tools available to the agent (includes Hamiltonian MCP by default) */
  tools: string[];
  tokensIn?: number;
  tokensOut?: number;
  contextPct?: number; // 0-100%
  progress?: number; // 0-100% completion progress
  rpmLimit?: number;
  tpmLimit?: number;
  activeTimeMs?: number;
  paused?: boolean;
  actionLog?: SandboxAction[];
  parentId?: string | null;
  position?: { x: number; y: number };
  diffPreview?: string;
  blackboardEntries?: Array<{ key: string; value: string; updatedAt: number }>;
  thoughtStream?: Array<{ text: string; elapsedMs: number; ts: number }>;
  childIds?: string[];
  providerId?: string;
  /** Browser viewport URL when mode is browser */
  url?: string;
  /** Optional screenshot data-url or remote path */
  screenshotUrl?: string;
  cwd?: string;
  logs: SandboxLogLine[];
  toolCallCount: number;
  startedAt?: number;
  focused?: boolean;
  /** Recent files this agent wrote */
  filesWritten?: string[];
}

export interface SandboxGridSnapshot {
  sandboxes: AgentSandbox[];
  browserOnline: boolean;
  engineOnline: boolean;
  maxVisible: number;
  updatedAt: string;
}
