// Typed API Client Service Layer
// Generic wrappers with typed error unions and request deduplication

const BASE_URL = "";

interface ApiError {
  ok: false;
  status: number;
  error: string;
}

interface ApiSuccess<T> {
  ok: true;
  data: T;
}

type ApiResponse<T> = ApiSuccess<T> | ApiError;

// In-flight request deduplication
const inFlight = new Map<string, Promise<any>>();

function requestKey(method: string, url: string, body?: any): string {
  return `${method}:${url}:${body ? JSON.stringify(body) : ""}`;
}

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function apiRequest<T>(
  method: string,
  endpoint: string,
  body?: any,
  opts?: { timeout?: number; dedupe?: boolean }
): Promise<ApiResponse<T>> {
  const url = `${BASE_URL}${endpoint}`;
  const key = requestKey(method, url, body);

  // Deduplication
  if (opts?.dedupe !== false && inFlight.has(key)) {
    const result = await inFlight.get(key);
    return result;
  }

  const promise = (async () => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetchWithTimeout(
        url,
        {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        },
        opts?.timeout
      );

      if (res.status === 401) {
        // Global logout on 401
        if (typeof window !== "undefined") {
          localStorage.removeItem("auth_token");
          window.location.href = "/login";
        }
        return { ok: false as const, status: 401, error: "Unauthorized" } as ApiResponse<T>;
      }

      if (!res.ok) {
        const text = await res.text();
        return { ok: false as const, status: res.status, error: text || `HTTP ${res.status}` } as ApiResponse<T>;
      }

      const data = await res.json();
      return { ok: true as const, data } as ApiResponse<T>;
    } catch (e: any) {
      if (e.name === "AbortError") {
        return { ok: false as const, status: 0, error: "Request timeout" } as ApiResponse<T>;
      }
      return { ok: false as const, status: 0, error: e.message } as ApiResponse<T>;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

// ─── Generic CRUD ─────────────────────────────────────────────────

export async function get<T>(endpoint: string, opts?: { timeout?: number }): Promise<ApiResponse<T>> {
  return apiRequest<T>("GET", endpoint, undefined, opts);
}

export async function post<T>(endpoint: string, body: any, opts?: { timeout?: number }): Promise<ApiResponse<T>> {
  return apiRequest<T>("POST", endpoint, body, opts);
}

export async function patch<T>(endpoint: string, body: any, opts?: { timeout?: number }): Promise<ApiResponse<T>> {
  return apiRequest<T>("PATCH", endpoint, body, opts);
}

export async function del<T>(endpoint: string, opts?: { timeout?: number }): Promise<ApiResponse<T>> {
  return apiRequest<T>("DELETE", endpoint, undefined, opts);
}

// ─── Domain-specific APIs ────────────────────────────────────────

export const agentsApi = {
  list: () => get<{ ok: boolean; agents: any[] }>("/api/swarm-market/agents"),
  create: (name: string, ownerName?: string) =>
    post<{ ok: boolean; agent: any }>("/api/swarm-market/agents", { name, owner_name: ownerName || "User" }),
  joinCollective: (agentId: string) =>
    patch<{ ok: boolean }>("/api/swarm-market/agents", { action: "join_collective", agent_id: agentId }),
};

export const tasksApi = {
  list: () => get<{ ok: boolean; tasks: any[] }>("/api/swarm-market/tasks"),
  create: (title: string, description?: string, difficulty?: number, reward?: number) =>
    post<{ ok: boolean; task: any }>("/api/swarm-market/tasks", {
      title,
      description: description || "",
      difficulty: difficulty || 5,
      reward_points: reward || 100,
    }),
  complete: (taskId: string, agentId: string) =>
    patch<{ ok: boolean }>("/api/swarm-market/tasks", { action: "complete", task_id: taskId, agent_id: agentId }),
};

export const orchestratorApi = {
  getState: () => get<{ ok: boolean; state: any }>("/api/orchestrator"),
  submitTask: (title: string, description: string, priority: number) =>
    post<{ ok: boolean; task: any }>("/api/orchestrator/tasks", {
      action: "submit",
      title,
      description,
      priority,
      requirements: [],
    }),
  schedule: () => post<{ ok: boolean; task: any }>("/api/orchestrator/tasks", { action: "schedule" }),
  complete: (taskId: string, result: string) =>
    post<{ ok: boolean }>("/api/orchestrator/tasks", { action: "complete", taskId, result }),
  fail: (taskId: string, error: string) =>
    post<{ ok: boolean }>("/api/orchestrator/tasks", { action: "fail", taskId, error }),
};

export const capabilitiesApi = {
  listProfiles: () => get<{ ok: boolean; profiles: any[] }>("/api/capabilities"),
  createProfile: (profile: any) => post<{ ok: boolean; profile: any }>("/api/capabilities", profile),
  deleteProfile: (id: string) => del<{ ok: boolean }>(`/api/capabilities?id=${id}`),
  match: (requirements: any[]) => post<{ ok: boolean; matches: any[] }>("/api/capabilities/match", { requirements }),
  formTeam: (request: any) => post<{ ok: boolean; team: any }>("/api/capabilities/teams", request),
};

export const inferenceApi = {
  listModels: () => get<{ ok: boolean; models: any[] }>("/api/inference"),
  run: (messages: Array<{ role: string; content: string }>, opts?: { temperature?: number; maxTokens?: number; preferredModel?: string }) =>
    post<{ ok: boolean; routing: any; result: any; latency_ms: number }>("/api/inference", {
      messages,
      temperature: opts?.temperature ?? 0.7,
      maxTokens: opts?.maxTokens ?? 2048,
      preferredModel: opts?.preferredModel,
    }),
};

export const statsApi = {
  get: () => get<{ ok: boolean; stats: any }>("/api/swarm-market/stats"),
};
