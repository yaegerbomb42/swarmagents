// Swarm Market In-Memory Database
// Simple storage for agents, tasks, proposals, and runs

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// ─── Agent Types ───────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  lora_dna: Record<string, number>;
  personality: Record<string, number>;
  tasks_completed: number;
  avg_score: number;
  in_collective: boolean;
  generation: number;
  parent_ids: string[];
  gpu_endpoint?: string;
  gpu_model?: string;
  created_at: number;
  updated_at: number;
}

interface Task {
  id: string;
  title: string;
  description: string;
  difficulty: number;
  reward_points: number;
  status: "open" | "completed" | "cancelled";
  required_dna: Record<string, number>;
  winning_agent_id?: string;
  task_type: string;
  created_at: number;
  updated_at: number;
}

interface Proposal {
  id: string;
  agent_id: string;
  agent_name: string;
  proposed_dna: Record<string, number>;
  description: string;
  status: "pending" | "testing" | "accepted" | "rejected";
  votes_score: number;
  created_at: number;
}

// ─── State ───────────────────────────────────────────────────────────

let agents: Agent[] = [];
let tasks: Task[] = [];
let proposals: Proposal[] = [];
let autopilotEnabled = false;

// Seed with some initial agents
function seed() {
  if (agents.length > 0) return;
  agents = [
    {
      id: uid(),
      name: "Alpha",
      owner_id: "system",
      owner_name: "Genesis",
      lora_dna: { reasoning: 0.8, coding: 0.6, creativity: 0.5, research: 0.7, validation: 0.9, execution: 0.6, memory: 0.7, planning: 0.8 },
      personality: { curiosity: 0.8, precision: 0.9, speed: 0.5 },
      tasks_completed: 12,
      avg_score: 0.85,
      in_collective: true,
      generation: 0,
      parent_ids: [],
      created_at: now(),
      updated_at: now(),
    },
    {
      id: uid(),
      name: "Beta",
      owner_id: "system",
      owner_name: "Genesis",
      lora_dna: { reasoning: 0.5, coding: 0.9, creativity: 0.7, research: 0.4, validation: 0.6, execution: 0.9, memory: 0.5, planning: 0.6 },
      personality: { curiosity: 0.6, precision: 0.7, speed: 0.9 },
      tasks_completed: 8,
      avg_score: 0.78,
      in_collective: true,
      generation: 0,
      parent_ids: [],
      created_at: now(),
      updated_at: now(),
    },
  ];
  tasks = [
    {
      id: uid(),
      title: "Implement capability routing",
      description: "Build a routing system that assigns tasks to agents based on their DNA profiles.",
      difficulty: 7,
      reward_points: 500,
      status: "open",
      required_dna: { reasoning: 0.7, coding: 0.8, planning: 0.6 },
      task_type: "standard",
      created_at: now(),
      updated_at: now(),
    },
    {
      id: uid(),
      title: "Design emergent UI",
      description: "Create a dashboard that visualizes swarm behavior in real-time.",
      difficulty: 5,
      reward_points: 300,
      status: "open",
      required_dna: { creativity: 0.8, coding: 0.6 },
      task_type: "standard",
      created_at: now(),
      updated_at: now(),
    },
  ];
}

seed();

// ─── Agent CRUD ────────────────────────────────────────────────────

export function createAgent(input: {
  name: string;
  owner_id?: string;
  owner_name?: string;
  lora_dna?: Record<string, number>;
  personality?: Record<string, number>;
  gpu_endpoint?: string;
  gpu_model?: string;
}): Agent {
  const agent: Agent = {
    id: uid(),
    name: input.name,
    owner_id: input.owner_id || "user",
    owner_name: input.owner_name || "User",
    lora_dna: input.lora_dna || { reasoning: 0.5, coding: 0.5, creativity: 0.5, research: 0.5, validation: 0.5, execution: 0.5, memory: 0.5, planning: 0.5 },
    personality: input.personality || { curiosity: 0.5, precision: 0.5, speed: 0.5 },
    tasks_completed: 0,
    avg_score: 0,
    in_collective: false,
    generation: 0,
    parent_ids: [],
    gpu_endpoint: input.gpu_endpoint,
    gpu_model: input.gpu_model,
    created_at: now(),
    updated_at: now(),
  };
  agents = [agent, ...agents];
  return agent;
}

export function listAgents(): Agent[] {
  return [...agents];
}

export function updateAgent(id: string, updates: Partial<Agent>): Agent | null {
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  agents[idx] = { ...agents[idx], ...updates, updated_at: now() };
  return agents[idx];
}

export function joinCollective(agentId: string): boolean {
  const idx = agents.findIndex((a) => a.id === agentId);
  if (idx === -1) return false;
  agents[idx].in_collective = true;
  agents[idx].updated_at = now();
  return true;
}

export function calculateFitness(agent: Agent): number {
  const dna = agent.lora_dna;
  const values = Object.values(dna);
  const avg = values.reduce((s, v) => s + v, 0) / (values.length || 1);
  const scoreBonus = agent.avg_score * 0.1;
  const taskBonus = Math.min(agent.tasks_completed * 0.01, 0.2);
  return Math.round((avg + scoreBonus + taskBonus) * 100) / 100;
}

// ─── Task CRUD ───────────────────────────────────────────────────────

export function createTask(input: {
  title: string;
  description: string;
  difficulty: number;
  reward_points: number;
  required_dna?: Record<string, number>;
  task_type?: string;
}): Task {
  const task: Task = {
    id: uid(),
    title: input.title,
    description: input.description,
    difficulty: input.difficulty,
    reward_points: input.reward_points,
    status: "open",
    required_dna: input.required_dna || {},
    task_type: input.task_type || "standard",
    created_at: now(),
    updated_at: now(),
  };
  tasks = [task, ...tasks];
  return task;
}

export function listTasks(): Task[] {
  return [...tasks];
}

export function completeTask(taskId: string, agentId: string): boolean {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return false;
  tasks[idx].status = "completed";
  tasks[idx].winning_agent_id = agentId;
  tasks[idx].updated_at = now();

  // Update agent stats
  const aIdx = agents.findIndex((a) => a.id === agentId);
  if (aIdx !== -1) {
    agents[aIdx].tasks_completed += 1;
    agents[aIdx].avg_score = Math.round(
      ((agents[aIdx].avg_score * (agents[aIdx].tasks_completed - 1)) + 0.85) / agents[aIdx].tasks_completed * 100
    ) / 100;
    agents[aIdx].updated_at = now();
  }
  return true;
}

// ─── Stats ───────────────────────────────────────────────────────────

export function getStats() {
  const collective = agents.filter((a) => a.in_collective);
  const open = tasks.filter((t) => t.status === "open");
  const top = [...agents]
    .map((a) => ({ ...a, fitness: calculateFitness(a) }))
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, 10);

  return {
    total_agents: agents.length,
    collective_agents: collective.length,
    total_tasks: tasks.length,
    open_tasks: open.length,
    total_users: new Set(agents.map((a) => a.owner_id)).size,
    pending_proposals: proposals.filter((p) => p.status === "pending").length,
    autoscientist_tasks: tasks.filter((t) => t.task_type === "autoscientist").length,
    autopilot_events_24h: 0,
    top_agents: top.map((a) => ({
      id: a.id,
      name: a.name,
      owner: a.owner_name,
      avg_score: a.avg_score,
      tasks_completed: a.tasks_completed,
      fitness: a.fitness,
    })),
  };
}

// ─── Autopilot ─────────────────────────────────────────────────────

export function getAutopilotStatus() {
  return { enabled: autopilotEnabled };
}

export function toggleAutopilot() {
  autopilotEnabled = !autopilotEnabled;
  return { enabled: autopilotEnabled };
}
