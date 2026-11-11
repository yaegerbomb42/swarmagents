// Runtime types for mission orchestration, agent specialization, and capability matching

export interface ApprovalState {
  status: "not-required" | "pending" | "approved" | "rejected";
  approver?: string;
  timestamp?: number;
  reason?: string;
}

export interface MissionCreateInput {
  title?: string;
  prompt: string;
  source?: string;
}

export interface MissionIntent {
  id: string;
  title: string;
  prompt: string;
  source: string;
  createdAt: number;
}

export interface MissionStep {
  id: string;
  title: string;
  description: string;
  state: "ready" | "running" | "done" | "failed" | "skipped" | "pending";
  requiresApproval: boolean;
  assignedAgent?: string;
  capabilityRequirements?: CapabilityRequirement[];
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  owner?: string;
  tool?: string;
  dependsOn?: string[];
  confidence?: number;
}

export interface MissionPlan {
  id: string;
  missionId: string;
  summary: string;
  state: "planned" | "queued" | "running" | "complete" | "failed";
  approvalState: "not-required" | "pending" | "approved" | "rejected";
  confidence: number;
  steps: MissionStep[];
  createdAt: number;
  updatedAt: number;
  reasoning: string;
}

export interface MissionState {
  mission: MissionIntent;
  plan: MissionPlan;
  run: RunTrace;
}

export interface PlanStepInput {
  title: string;
  description: string;
  requiresApproval?: boolean;
  tool?: string;
  owner?: string;
  confidence?: number;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  enabled: boolean;
  condition: string;
  action: "allow" | "warn" | "require_approval" | "block";
}

export interface RunEvent {
  id: string;
  runId: string;
  type: string;
  ts: number;
  title: string;
  detail?: string;
  stepId?: string;
  severity?: "info" | "warn" | "error";
  metadata?: Record<string, unknown>;
}

export interface RunState {
  status: "idle" | "planning" | "waiting-approval" | "running" | "paused" | "complete" | "failed";
  currentStepId?: string;
  progress: number;
}

export interface RunTrace {
  id: string;
  planId: string;
  state: RunState;
  events: RunEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  domain: string;
  proficiency: number;
  experienceHours: number;
  taskCount: number;
  lastUsed: number;
  lastUsedAt: number;
  status: "candidate" | "validated" | "deprecated";
  version: number;
  confidence: number;
  evidence: Array<{ runId: string; stepId: string; title: string; detail: string }>;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface SpecializationRecord {
  id: string;
  name: string;
  description: string;
  status: "active" | "inactive" | "deprecated";
  version: string;
  capabilities: string[];
  requiredTools: string[];
  createdAt: number;
  updatedAt: number;
}

// ─── Capability Profile System (Tasks 401-500) ─────────────────────────────

export interface CapabilityProfile {
  id: string;
  agentId: string;
  agentName: string;
  capabilitySet: CapabilityEntry[];
  proficiencyLevel: number; // 0-100 aggregate
  experienceHours: number;
  taskCount: number;
  performanceMetrics: {
    quality: number;      // 0-100
    speed: number;        // 0-100
    reliability: number;  // 0-100
    collaboration: number; // 0-100
  };
  capabilityVersion: string;
  lastUpdated: number;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface CapabilityEntry {
  name: string;
  proficiency: number; // 0-100
  experienceHours: number;
  taskCount: number;
  lastUsed: number;
  verified: boolean;
}

export interface CapabilityRequirement {
  capability: string;
  minimumProficiency: number; // 0-100
  preferredProficiency?: number;
  weight: number; // 0-1, importance of this requirement
  type: "mandatory" | "optional" | "nice-to-have";
  metadata?: Record<string, unknown>;
}

export interface MatchResult {
  profileId: string;
  agentId: string;
  agentName: string;
  totalScore: number; // 0-100
  confidence: number;   // 0-1
  capabilityScores: Record<string, number>;
  matchedRequirements: number;
  totalRequirements: number;
  missingCapabilities: string[];
  routingReason: string;
}

export interface TeamFormationRequest {
  taskRequirements: CapabilityRequirement[];
  minTeamSize: number;
  maxTeamSize: number;
  strategy: "stigmergy" | "capability-based" | "performance-based" | "diversity-based" | "minimal";
  diversityWeight?: number;
  performanceWeight?: number;
}

export interface FormedTeam {
  id: string;
  members: MatchResult[];
  coverage: number; // 0-1, how well requirements are covered
  diversityScore: number;
  predictedPerformance: number;
  formationStrategy: string;
  formedAt: number;
}

export interface RuntimeSnapshot {
  mission: MissionIntent | null;
  plan: MissionPlan | null;
  run: RunTrace | null;
  skills: SkillRecord[];
  specializations: SpecializationRecord[];
  policies: PolicyRule[];
  capabilityProfiles?: CapabilityProfile[];
  formedTeams?: FormedTeam[];
}
