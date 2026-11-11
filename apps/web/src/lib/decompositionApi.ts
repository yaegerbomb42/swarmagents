/**
 * API Client for Task Decomposition System
 * Type-safe client for all backend endpoints
 */

import {
  CreateProjectRequest,
  ProjectResponse,
  TaskTree,
  TaskNode,
  TaskStatus,
  TaskType,
  Branch,
  WorkerAgent,
  WorkerPoolMetrics,
  TimeBudget,
  Deliverable,
  DeliverableType,
  QuantumRouterMetrics,
} from "@/types/decomposition";
import { authHeaders } from "@/lib/auth";
import { ENGINE_URL, ENGINE_WS_URL } from "@/lib/config";

function buildApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    return "/api/engine/api/decomposition";
  }
  const trimmedUrl = ENGINE_URL.replace(/\/$/, "");
  return trimmedUrl.endsWith("/api/decomposition") ? trimmedUrl : `${trimmedUrl}/api/decomposition`;
}

const API_BASE_URL = buildApiBaseUrl();

export class DecompositionApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public detail?: any
  ) {
    super(message);
    this.name = "DecompositionApiError";
  }
}


function requestHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...authHeaders(), ...(extra || {}) };
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Unknown error",
      detail: response.statusText,
    }));
    if (response.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
    }
    throw new DecompositionApiError(
      error.error || "API request failed",
      response.status,
      error.detail
    )
  }
  return response.json();
}

export function normalizeTaskNode(raw: any): TaskNode {
  return {
    id: raw?.id || "",
    tree_id: raw?.tree_id || "",
    parent_id: raw?.parent_id ?? null,
    type: (raw?.type || TaskType.LEAF) as TaskType,
    status: (raw?.status || TaskStatus.PENDING) as TaskStatus,
    description: raw?.description || "",
    requirements: raw?.requirements || [],
    acceptance_criteria: raw?.acceptance_criteria || [],
    children: raw?.children || [],
    depth: raw?.depth ?? 0,
    path: raw?.path || "",
    assigned_worker_id: raw?.assigned_worker_id ?? null,
    branch_id: raw?.branch_id ?? null,
    priority: raw?.priority ?? 0,
    estimated_duration: raw?.estimated_duration ?? 0,
    actual_duration: raw?.actual_duration ?? null,
    time_budget: raw?.time_budget ?? 0,
    created_at: raw?.created_at || new Date().toISOString(),
    started_at: raw?.started_at ?? null,
    completed_at: raw?.completed_at ?? null,
    quality_score: raw?.quality_score ?? null,
    validation_passed: raw?.validation_passed ?? null,
    validation_feedback: raw?.validation_feedback || "",
    retry_count: raw?.retry_count ?? 0,
    max_retries: raw?.max_retries ?? 3,
    last_error: raw?.last_error || "",
    output: raw?.output || {},
    artifacts: raw?.artifacts || [],
    dependencies: raw?.dependencies || [],
    blocked_by: raw?.blocked_by || [],
    metadata: raw?.metadata || {},
    tags: raw?.tags || [],
  };
}

function normalizeBranches(rawBranches: Record<string, any> = {}): Record<string, Branch> {
  return Object.fromEntries(
    Object.entries(rawBranches).map(([branchId, branch]) => [
      branchId,
      {
        id: branch?.id || branchId,
        tree_id: branch?.tree_id || "",
        parent_node_id: branch?.parent_node_id || "",
        root_node_id: branch?.root_node_id || "",
        status: (branch?.status || "active") as Branch["status"],
        node_ids: branch?.node_ids || [],
        created_at: branch?.created_at || new Date().toISOString(),
        completed_at: branch?.completed_at ?? null,
        merged_into: branch?.merged_into ?? null,
        merge_conflicts: branch?.merge_conflicts || [],
        merge_resolution: branch?.merge_resolution || {},
        metadata: branch?.metadata || {},
      },
    ])
  );
}

export function normalizeTimeBudget(raw: any): TimeBudget {
  return {
    tree_id: raw?.tree_id || "",
    total_seconds: raw?.total_seconds ?? 0,
    node_allocations: raw?.node_allocations || {},
    node_consumed: raw?.node_consumed || {},
    total_consumed: raw?.total_consumed ?? 0,
    total_remaining: raw?.total_remaining ?? 0,
    warning_threshold: raw?.warning_threshold ?? 0.8,
    critical_threshold: raw?.critical_threshold ?? 0.95,
    is_exceeded: raw?.is_exceeded ?? false,
    is_warning: raw?.is_warning ?? false,
    is_critical: raw?.is_critical ?? false,
    created_at: raw?.created_at || new Date().toISOString(),
    last_updated_at: raw?.last_updated_at || new Date().toISOString(),
  };
}

export function normalizeTaskTree(raw: any): TaskTree {
  const nodes = Object.fromEntries(
    Object.entries(raw?.nodes || {}).map(([nodeId, node]) => [nodeId, normalizeTaskNode(node)])
  ) as Record<string, TaskNode>;
  const rootNode = nodes[raw?.root_node_id];
  const nodeValues = Object.values(nodes);
  const estimatedBudget = nodeValues.reduce((total, node) => total + (node.time_budget || 0), 0);
  const consumedTime = nodeValues.reduce((total, node) => total + (node.actual_duration || 0), 0);

  return {
    id: raw?.id || raw?.tree_id || "",
    project_id: raw?.project_id || "",
    root_node_id: raw?.root_node_id || "",
    root_description: raw?.root_description || rootNode?.description || "",
    status: raw?.status || "pending",
    nodes,
    branches: normalizeBranches(raw?.branches),
    created_at: raw?.created_at || rootNode?.created_at || new Date().toISOString(),
    started_at: raw?.started_at ?? null,
    completed_at: raw?.completed_at ?? null,
    total_time_budget: raw?.total_time_budget ?? rootNode?.time_budget ?? estimatedBudget,
    time_consumed: raw?.time_consumed ?? consumedTime,
    total_nodes: raw?.total_nodes ?? nodeValues.length,
    completed_nodes: raw?.completed_nodes ?? nodeValues.filter((node) => node.status === TaskStatus.COMPLETED).length,
    failed_nodes: raw?.failed_nodes ?? nodeValues.filter((node) => node.status === TaskStatus.FAILED).length,
    deliverable_type: (raw?.deliverable_type || rootNode?.metadata?.deliverable_type || DeliverableType.OTHER) as DeliverableType,
    deliverable_path: raw?.deliverable_path ?? null,
    metadata: {
      ...(raw?.metadata || {}),
      progress_percent: raw?.progress_percent ?? 0,
    },
  };
}

export class DecompositionApi {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  // Project Management
  async createProject(request: CreateProjectRequest): Promise<ProjectResponse> {
    const response = await fetch(`${this.baseUrl}/projects`, {
      method: "POST",
      headers: { ...authHeaders(),  "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return handleResponse<ProjectResponse>(response);
  }

  async getProject(projectId: string): Promise<ProjectResponse> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}`, { headers: requestHeaders() });
    return handleResponse<ProjectResponse>(response);
  }

  async listProjects(params?: {
    status?: string;
    deliverable_type?: DeliverableType;
    limit?: number;
    offset?: number;
  }): Promise<{ projects: ProjectResponse[]; total: number; limit: number; offset: number }> {
    const queryParams = new URLSearchParams();
    if (params?.status) queryParams.append("status", params.status);
    if (params?.deliverable_type) queryParams.append("deliverable_type", params.deliverable_type);
    if (params?.limit) queryParams.append("limit", params.limit.toString());
    if (params?.offset) queryParams.append("offset", params.offset.toString());

    const response = await fetch(`${this.baseUrl}/projects?${queryParams}`, { headers: requestHeaders() });
    return handleResponse(response);
  }

  async deleteProject(projectId: string): Promise<{ message: string }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}`, {
      headers: requestHeaders(),
      method: "DELETE",
    });
    return handleResponse(response);
  }

  async pauseProject(projectId: string): Promise<{ message: string }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/pause`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  async resumeProject(projectId: string): Promise<{ message: string }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/resume`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  async cancelProject(projectId: string): Promise<{ message: string }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/cancel`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  // Task Tree Management
  async getTaskTree(projectId: string): Promise<TaskTree> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/tree`, { headers: requestHeaders() });
    const raw = await handleResponse<any>(response);
    return normalizeTaskTree(raw);
  }

  async getTaskNode(projectId: string, nodeId: string): Promise<TaskNode> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/nodes/${nodeId}`, { headers: requestHeaders() });
    const raw = await handleResponse<any>(response);
    return normalizeTaskNode(raw);
  }

  async splitTaskNode(projectId: string, nodeId: string): Promise<{ message: string; children: string[] }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/tree/nodes/${nodeId}/split`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  async assignTask(
    projectId: string,
    nodeId: string,
    workerId?: string,
    preferences?: Record<string, any>
  ): Promise<{ message: string; worker_id: string }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/tree/nodes/${nodeId}/assign`, {
      method: "POST",
      headers: { ...authHeaders(),  "Content-Type": "application/json" },
      body: JSON.stringify({ worker_id: workerId, preferences }),
    });
    return handleResponse(response);
  }

  async executeProject(
    projectId: string,
    maxIterations: number = 1000
  ): Promise<{ success: boolean; project_id: string; tree_id: string; message: string }> {
    const params = new URLSearchParams({ max_iterations: maxIterations.toString() });
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/execute?${params}`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  async retryTask(projectId: string, nodeId: string): Promise<{ message: string }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/tree/nodes/${nodeId}/retry`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  // Branch Management
  async listBranches(projectId: string): Promise<Branch[]> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/branches`, { headers: requestHeaders() });
    return handleResponse<Branch[]>(response);
  }

  async createBranch(
    projectId: string,
    description: string,
    parentNodeId: string,
    metadata?: Record<string, any>
  ): Promise<Branch> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/branches`, {
      method: "POST",
      headers: { ...authHeaders(),  "Content-Type": "application/json" },
      body: JSON.stringify({ description, parent_node_id: parentNodeId, metadata }),
    });
    return handleResponse<Branch>(response);
  }

  async mergeBranch(
    projectId: string,
    branchId: string
  ): Promise<{ message: string; conflicts: string[] }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/branches/${branchId}/merge`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  // Worker Management
  async getWorkerPoolStatus(): Promise<WorkerPoolMetrics> {
    const response = await fetch(`${this.baseUrl}/workers`, { headers: requestHeaders() });
    return handleResponse<WorkerPoolMetrics>(response);
  }

  async getWorker(workerId: string): Promise<WorkerAgent> {
    const response = await fetch(`${this.baseUrl}/workers/${workerId}`, { headers: requestHeaders() });
    return handleResponse<WorkerAgent>(response);
  }

  async restartWorker(workerId: string): Promise<{ message: string }> {
    const response = await fetch(`${this.baseUrl}/workers/${workerId}/restart`, {
      headers: requestHeaders(),
      method: "POST",
    });
    return handleResponse(response);
  }

  // Time Budget Management
  async getTimeBudget(projectId: string): Promise<TimeBudget> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/budget`, { headers: requestHeaders() });
    const raw = await handleResponse<any>(response);
    return normalizeTimeBudget(raw);
  }

  async reallocateBudget(
    projectId: string,
    strategy: "proportional" | "priority" | "equal"
  ): Promise<{ message: string; budget: TimeBudget }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/budget/reallocate`, {
      method: "POST",
      headers: { ...authHeaders(),  "Content-Type": "application/json" },
      body: JSON.stringify({ strategy }),
    });
    return handleResponse(response);
  }

  // Deliverable Management
  async getDeliverableStatus(projectId: string): Promise<Deliverable> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/deliverable`, { headers: requestHeaders() });
    return handleResponse<Deliverable>(response);
  }

  async downloadDeliverable(projectId: string): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/deliverable/download`, { headers: requestHeaders() });
    if (!response.ok) {
      throw new DecompositionApiError("Failed to download deliverable", response.status);
    }
    return response.blob();
  }

  // Quantum Router Management
  async getQuantumRouterMetrics(projectId: string): Promise<QuantumRouterMetrics> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/quantum/metrics`, { headers: requestHeaders() });
    return handleResponse<QuantumRouterMetrics>(response);
  }

  async getQuantumRouterState(projectId: string): Promise<{ state: any; statistics: any }> {
    const response = await fetch(`${this.baseUrl}/projects/${projectId}/quantum/state`, { headers: requestHeaders() });
    return handleResponse(response);
  }

  // Health Check
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    const rootUrl =
      typeof window !== "undefined"
        ? "/api/engine"
        : this.baseUrl.replace(/\/api\/decomposition$/, "");
    const response = await fetch(`${rootUrl}/health`, { headers: requestHeaders() });
    return handleResponse(response);
  }

  // WebSocket URL — always derived from lib/config ENGINE_WS_URL (never hardcoded host)
  getWebSocketUrl(projectId: string): string {
    const base = ENGINE_WS_URL.replace(/\/$/, "");
    return `${base}/api/decomposition/ws/${projectId}`;
  }
}

// Singleton instance
export const decompositionApi = new DecompositionApi();

// Made with Bob
