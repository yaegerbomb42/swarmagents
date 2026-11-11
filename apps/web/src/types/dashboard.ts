export interface EngineMetrics {
  correctness: number;
  aps: number;
  tokenEff: number;
  tokensUsed: number;
  tokensQuota: number;
  spend: number;
}

export interface ThoughtEntry {
  id: string;
  timestamp: number;
  role: string;
  content: string;
  type?: 'reasoning' | 'action' | 'observation' | 'error';
}

export interface ThoughtTreeUpdate {
  nodeId: string;
  parentId?: string;
  label: string;
  status: 'active' | 'complete' | 'failed';
}

export interface WorkerInfo {
  id: string;
  provider: string;
  model: string;
  status: 'ready' | 'busy' | 'cooldown' | 'error';
  avg_tps: number;
  total_tokens: number;
}

export interface ToolLogEntry {
  id: string;
  tool: string;
  input: string;
  output: string;
  timestamp: number;
  duration_ms: number;
  status: 'success' | 'error';
}
