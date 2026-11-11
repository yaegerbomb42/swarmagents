/**
 * TypeScript types for the Task Decomposition System
 * Matches backend models from engine/decomposition/models.py
 */

export enum TaskStatus {
  PENDING = "pending",
  DECOMPOSING = "decomposing",
  READY = "ready",
  ASSIGNED = "assigned",
  EXECUTING = "executing",
  VALIDATING = "validating",
  COMPLETED = "completed",
  FAILED = "failed",
  BLOCKED = "blocked",
  CANCELLED = "cancelled",
}

export enum TaskType {
  ROOT = "root",
  COMPOSITE = "composite",
  LEAF = "leaf",
}

export enum BranchStatus {
  ACTIVE = "active",
  COMPLETED = "completed",
  FAILED = "failed",
  MERGED = "merged",
}

export enum DeliverableType {
  PDF = "pdf",
  CODEBASE = "codebase",
  WEBSITE = "website",
  DOCUMENT = "document",
  DATASET = "dataset",
  MODEL = "model",
  API = "api",
  OTHER = "other",
}

export enum WorkerStatus {
  IDLE = "idle",
  BUSY = "busy",
  FAILED = "failed",
  OFFLINE = "offline",
}

export interface TaskNode {
  id: string;
  tree_id: string;
  parent_id: string | null;
  type: TaskType;
  status: TaskStatus;
  description: string;
  requirements: string[];
  acceptance_criteria: string[];
  children: string[];
  depth: number;
  path: string;
  assigned_worker_id: string | null;
  branch_id: string | null;
  priority: number;
  estimated_duration: number;
  actual_duration: number | null;
  time_budget: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  quality_score: number | null;
  validation_passed: boolean | null;
  validation_feedback: string;
  retry_count: number;
  max_retries: number;
  last_error: string;
  output: Record<string, any>;
  artifacts: string[];
  dependencies: string[];
  blocked_by: string[];
  metadata: Record<string, any>;
  tags: string[];
}

export interface Branch {
  id: string;
  tree_id: string;
  parent_node_id: string;
  root_node_id: string;
  status: BranchStatus;
  node_ids: string[];
  created_at: string;
  completed_at: string | null;
  merged_into: string | null;
  merge_conflicts: string[];
  merge_resolution: Record<string, any>;
  metadata: Record<string, any>;
}

export interface TaskTree {
  id: string;
  project_id: string;
  root_node_id: string;
  root_description: string;
  status: string;
  nodes: Record<string, TaskNode>;
  branches: Record<string, Branch>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total_time_budget: number;
  time_consumed: number;
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
  deliverable_type: DeliverableType;
  deliverable_path: string | null;
  metadata: Record<string, any>;
}

export interface WorkerAgent {
  id: string;
  name: string;
  model_name: string;
  model_size_gb: number;
  provider: string;
  status: WorkerStatus;
  current_task_id: string | null;
  capabilities: string[];
  specialization: string | null;
  tasks_completed: number;
  tasks_failed: number;
  average_quality_score: number;
  average_execution_time: number;
  created_at: string;
  last_active_at: string | null;
  memory_usage_mb: number;
  cpu_usage_percent: number;
  metadata: Record<string, any>;
}

export interface TimeBudget {
  tree_id: string;
  total_seconds: number;
  node_allocations: Record<string, number>;
  node_consumed: Record<string, number>;
  total_consumed: number;
  total_remaining: number;
  warning_threshold: number;
  critical_threshold: number;
  is_exceeded: boolean;
  is_warning: boolean;
  is_critical: boolean;
  created_at: string;
  last_updated_at: string;
}

export interface Deliverable {
  id: string;
  tree_id: string;
  project_id: string;
  type: DeliverableType;
  format: string;
  title: string;
  description: string;
  assembled_from: string[];
  artifacts: string[];
  status: string;
  progress: number;
  output_path: string | null;
  output_url: string | null;
  output_size_bytes: number;
  quality_score: number | null;
  validation_passed: boolean;
  created_at: string;
  completed_at: string | null;
  metadata: Record<string, any>;
}

// API Request/Response types
export interface CreateProjectRequest {
  description: string;
  deliverable_type: DeliverableType;
  time_budget_hours: number;
  metadata?: Record<string, any>;
}

export interface ProjectResponse {
  project_id: string;
  tree_id: string;
  description: string;
  deliverable_type: DeliverableType;
  status: string;
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
  progress_percent: number;
  time_budget: number;
  time_consumed: number;
  time_remaining: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: Record<string, any>;
}

export interface WorkerPoolMetrics {
  total_workers: number;
  idle_workers: number;
  busy_workers: number;
  failed_workers: number;
  utilization: number;
  total_tasks_completed: number;
  total_tasks_failed: number;
  success_rate: number;
  average_quality_score: number;
  average_execution_time: number;
  workers?: WorkerAgent[];
}

export interface WebSocketMessage {
  type: "node_update" | "tree_update" | "worker_update" | "budget_update" | "error";
  project_id: string;
  tree_id?: string;
  node_id?: string;
  data: any;
  timestamp: string;
}

// React Flow types for visualization
export interface TreeNodeData {
  node: TaskNode;
  label: string;
  status: TaskStatus;
  type: TaskType;
}

export interface TreeEdgeData {
  animated?: boolean;
  label?: string;
}

// Quantum Router Types
export interface QuantumPulse {
  optimal_action: string;
  optimal_sequence: string[];
  thinking_style: string;
  confidence: number;
  features: number[];
  timestamp: string;
}

export interface QuantumRouterState {
  total_actions: number;
  action_counts: Record<string, number>;
  action_success_rates: Record<string, number>;
  attention_weights: number[];
  avg_weight_variance: number;
  neocortex_enabled: boolean;
  neocortex_stats?: {
    total_memories: number;
    avg_confidence: number;
    pruned_count: number;
  };
}

export interface QuantumRouterMetrics {
  current_pulse: QuantumPulse | null;
  router_state: QuantumRouterState;
  recent_pulses: QuantumPulse[];
  action_distribution: Record<string, number>;
  thinking_style_distribution: Record<string, number>;
  confidence_trend: number[];
}

// Made with Bob
