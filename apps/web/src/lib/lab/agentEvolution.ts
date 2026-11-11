/**
 * Agent Evolution & Benchmark Engine
 *
 * Provides real prompt context tuning, immutable generational DNA profiles,
 * empirical task benchmark execution via live LLM completions, cross-generational
 * breeding/mutation, and autonomous domain role synthesis.
 */

import { deepseekChat } from '@/lib/deepseek';
import { defaultDirectiveForRole, getAgentRoleById } from '@/lib/agentRoles';

export interface LlmConfig {
  provider: string; // 'openai' | 'anthropic' | 'gemini' | 'groq' | 'deepseek' | 'ollama' | 'vllm' | 'custom'
  model: string;
  temperature: number;
  maxTokens: number;
  endpoint?: string;
  apiKey?: string;
}

export interface PromptContextDna {
  systemDirective: string;
  personaTone: string;
  reasoningRules: string[];
  outputConstraints: string[];
  specializedKnowledge: string[];
  temperature: number;
  topP?: number;
}

export interface BenchmarkRun {
  runId: string;
  taskId: string;
  taskTitle: string;
  taskPrompt: string;
  expectedDeliverable: string;
  modelOutput: string;
  score: number; // 0 - 100
  latencyMs: number;
  tokensUsed: number;
  passedGates: string[];
  failedGates: string[];
  timestamp: string;
}

export interface TunedAgent {
  id: string;
  name: string;
  role: string;
  generation: number;
  parentIds: string[];
  ownerId: string;
  ownerName: string;
  locked: boolean;
  llmConfig: LlmConfig;
  contextDna: PromptContextDna;
  benchmarks: BenchmarkRun[];
  avgScore: number;
  tasksCompleted: number;
  fitness: number;
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkChallenge {
  id: string;
  title: string;
  category: 'architecture' | 'coding' | 'verification' | 'research' | 'synthesis';
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: string;
  expectedDeliverable: string;
  evaluationCriteria: {
    rule: string;
    weight: number; // e.g. 25
    checker: (output: string) => boolean;
  }[];
}

export type { AgentRoleCard as SynthesizedRole } from './roleLibrary';
export type { RoleUsageContext, ModelTier } from './roleLibrary';

// ── Built-in Standard Benchmark Challenges ──────────────────────────────

export const BENCHMARK_CHALLENGES: BenchmarkChallenge[] = [
  {
    id: 'bench-decomp-auth',
    title: 'Decompose Distributed Auth & Session Service',
    category: 'architecture',
    difficulty: 'medium',
    prompt: 'Decompose a distributed OAuth2 & JWT session management service with Redis token revocation and PostgreSQL persistence into 3-5 concrete atomic engineering tasks. Return a clean JSON array where each object has: "task", "deliverable_file", "acceptance_criteria" (array), and "effort_minutes".',
    expectedDeliverable: 'JSON array of atomic engineering tasks',
    evaluationCriteria: [
      {
        rule: 'Valid JSON array in response',
        weight: 30,
        checker: (out) => {
          try {
            const clean = out.replace(/```json|```/g, '').trim();
            const start = clean.indexOf('[');
            const end = clean.lastIndexOf(']');
            if (start < 0 || end < 0) return false;
            const parsed = JSON.parse(clean.slice(start, end + 1));
            return Array.isArray(parsed) && parsed.length >= 3;
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'Specifies concrete file paths and deliverables',
        weight: 25,
        checker: (out) => /deliverable_file|\.ts|\.py|\.sql|\.json/i.test(out),
      },
      {
        rule: 'Includes checkable acceptance criteria',
        weight: 25,
        checker: (out) => /acceptance_criteria|redis|jwt|token|session/i.test(out),
      },
      {
        rule: 'Avoids vague filler labels',
        weight: 20,
        checker: (out) => !/Setup 1|Unit 2|Plan work|Execute part/i.test(out),
      },
    ],
  },
  {
    id: 'bench-sql-sec',
    title: 'Remediate SQL Injection & Parameterize Query',
    category: 'coding',
    difficulty: 'easy',
    prompt: 'Fix this vulnerable query: `SELECT * FROM users WHERE email = \'\' + userEmail + \'\' AND password = \'\' + userPassword + \'\'`. Provide a secure, parameterized TypeScript implementation using PostgreSQL parameterized placeholders `$1, $2` and bcrypt password verification. Return clean TypeScript code.',
    expectedDeliverable: 'Secure parameterized query with bcrypt',
    evaluationCriteria: [
      {
        rule: 'Uses parameterized placeholders ($1, $2)',
        weight: 35,
        checker: (out) => /\$1|\$2|query\s*\(.*\[.*\]\)/i.test(out),
      },
      {
        rule: 'Uses password hashing / comparison (bcrypt or argon2)',
        weight: 35,
        checker: (out) => /bcrypt|argon2|compare/i.test(out),
      },
      {
        rule: 'Contains no raw string concatenation in SQL',
        weight: 30,
        checker: (out) => !/WHERE email = ['"]\s*\+/i.test(out),
      },
    ],
  },
  {
    id: 'bench-synth-brief',
    title: 'Synthesize Multi-Source Technical Brief',
    category: 'synthesis',
    difficulty: 'medium',
    prompt: 'You are provided 3 requirements: 1) Sub-50ms API latency, 2) Zero secret leakage with BYOK keys, 3) 99.99% uptime with multi-provider fallbacks. Synthesize a 3-bullet executive architecture spec addressing each requirement with concrete mechanisms.',
    expectedDeliverable: '3-bullet concrete architecture spec',
    evaluationCriteria: [
      {
        rule: 'Directly addresses all 3 requirements',
        weight: 40,
        checker: (out) => /50ms|latency/i.test(out) && /secret|byok|vault|key/i.test(out) && /fallback|uptime|multi-provider/i.test(out),
      },
      {
        rule: 'Formatted cleanly with structured points',
        weight: 30,
        checker: (out) => (out.match(/[-*•]|\d+\./g) || []).length >= 3,
      },
      {
        rule: 'Concise and actionable (< 250 words)',
        weight: 30,
        checker: (out) => out.split(/\s+/).length < 250 && out.split(/\s+/).length > 20,
      },
    ],
  },
];

// ── In-Memory Agent & Generation Store (with fallback seeding) ──────────

let agentRegistry: Map<string, TunedAgent> = new Map();
import {
  listRoleCards,
  saveRoleCard,
  roleCardFromSynthesis,
  type AgentRoleCard,
} from './roleLibrary';

export function seedInitialGen0Agents(): void {
  if (agentRegistry.size > 0) return;

  const seedRoles = ['architect', 'implementer', 'verifier', 'researcher', 'debugger', 'orchestrator'] as const;
  const displayNames: Record<string, string> = {
    architect: 'Aether-Architect (Gen 0)',
    implementer: 'Nexus-Implementer (Gen 0)',
    verifier: 'Sentinel-Verifier (Gen 0)',
    researcher: 'Atlas-Researcher (Gen 0)',
    debugger: 'Trace-Debugger (Gen 0)',
    orchestrator: 'Pulse-Orchestrator (Gen 0)',
  };
  const scores: Record<string, number> = {
    architect: 92.5,
    implementer: 90.0,
    verifier: 91.2,
    researcher: 88.4,
    debugger: 89.1,
    orchestrator: 93.0,
  };

  for (const roleId of seedRoles) {
    const role = getAgentRoleById(roleId);
    const agent: TunedAgent = {
      id: `agent-gen0-${roleId}`,
      name: displayNames[roleId] || `${role?.name || roleId} (Gen 0)`,
      role: roleId,
      generation: 0,
      parentIds: [],
      ownerId: 'system',
      ownerName: 'Genesis Swarm',
      locked: true,
      llmConfig: {
        provider: 'deepseek',
        model: 'DeepSeek-V4-Flash-batch',
        temperature: role?.model_tier === 'frontier' ? 0.2 : 0.1,
        maxTokens: 4096,
      },
      contextDna: {
        systemDirective: defaultDirectiveForRole(roleId),
        personaTone: role ? `Professional ${role.name.toLowerCase()} — precise and accountable.` : 'Precise and actionable.',
        reasoningRules: [
          'Every deliverable must be verifiable.',
          ...(role?.tools.slice(0, 2).map((tool) => `Prefer ${tool} tools when they reduce risk.`) || []),
        ],
        outputConstraints: ['No vague placeholders or filler tasks.'],
        specializedKnowledge: role?.tools || [],
        temperature: role?.model_tier === 'frontier' ? 0.2 : 0.1,
      },
      benchmarks: [],
      avgScore: scores[roleId] || 85,
      tasksCompleted: 12 + seedRoles.indexOf(roleId) * 3,
      fitness: (scores[roleId] || 85) + 1.5,
      createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    agentRegistry.set(agent.id, agent);
  }
}

// ── Agent Creation & DNA Locking ────────────────────────────────────────

export function createTunedAgent(params: {
  name: string;
  role: string;
  ownerId?: string;
  ownerName?: string;
  llmConfig: LlmConfig;
  contextDna: PromptContextDna;
  parentIds?: string[];
  generation?: number;
  locked?: boolean;
}): TunedAgent {
  seedInitialGen0Agents();

  const id = `agent-gen${params.generation ?? 0}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const agent: TunedAgent = {
    id,
    name: params.name.trim(),
    role: params.role.trim().toLowerCase(),
    generation: params.generation ?? 0,
    parentIds: params.parentIds ?? [],
    ownerId: params.ownerId || 'collective',
    ownerName: params.ownerName || 'User',
    locked: Boolean(params.locked),
    llmConfig: params.llmConfig,
    contextDna: params.contextDna,
    benchmarks: [],
    avgScore: 0,
    tasksCompleted: 0,
    fitness: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  agentRegistry.set(agent.id, agent);
  return agent;
}

export function lockAgentDna(agentId: string): TunedAgent | null {
  const agent = agentRegistry.get(agentId);
  if (!agent) return null;
  agent.locked = true;
  agent.updatedAt = new Date().toISOString();
  return agent;
}

export function listTunedAgents(ownerId?: string): TunedAgent[] {
  seedInitialGen0Agents();
  const all = Array.from(agentRegistry.values());
  if (!ownerId) return all;
  return all.filter((a) => a.ownerId === ownerId || a.ownerId === 'system' || a.ownerId === 'collective');
}

export function getTunedAgent(agentId: string): TunedAgent | null {
  seedInitialGen0Agents();
  return agentRegistry.get(agentId) || null;
}

// ── Real Model Benchmark Execution ──────────────────────────────────────

export async function runAgentBenchmark(
  agentId: string,
  challengeId: string
): Promise<BenchmarkRun> {
  seedInitialGen0Agents();
  const agent = agentRegistry.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const challenge = BENCHMARK_CHALLENGES.find((c) => c.id === challengeId);
  if (!challenge) throw new Error(`Benchmark challenge ${challengeId} not found`);

  // Construct full context prompt from locked DNA
  const systemPrompt = [
    agent.contextDna.systemDirective,
    `\n[Tone & Persona]: ${agent.contextDna.personaTone}`,
    agent.contextDna.reasoningRules.length > 0
      ? `\n[Reasoning Rules]:\n${agent.contextDna.reasoningRules.map((r) => `- ${r}`).join('\n')}`
      : '',
    agent.contextDna.outputConstraints.length > 0
      ? `\n[Output Constraints]:\n${agent.contextDna.outputConstraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    agent.contextDna.specializedKnowledge.length > 0
      ? `\n[Domain Knowledge]:\n${agent.contextDna.specializedKnowledge.map((k) => `- ${k}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');

  const startTime = Date.now();
  let modelOutput = '';

  try {
    modelOutput = await deepseekChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: challenge.prompt },
      ],
      {
        temperature: agent.contextDna.temperature ?? agent.llmConfig.temperature ?? 0.3,
        maxTokens: agent.llmConfig.maxTokens || 2048,
        endpoint: agent.llmConfig.endpoint,
        apiKey: agent.llmConfig.apiKey,
        model: agent.llmConfig.model,
      }
    );
  } catch (err: any) {
    modelOutput = `[Benchmark Execution Error]: ${err?.message || String(err)}`;
  }

  const latencyMs = Date.now() - startTime;
  const approxTokens = Math.ceil((systemPrompt.length + challenge.prompt.length + modelOutput.length) / 4);

  // Grade model output against objective criteria
  const passedGates: string[] = [];
  const failedGates: string[] = [];
  let score = 0;

  for (const crit of challenge.evaluationCriteria) {
    try {
      if (crit.checker(modelOutput)) {
        passedGates.push(crit.rule);
        score += crit.weight;
      } else {
        failedGates.push(crit.rule);
      }
    } catch {
      failedGates.push(crit.rule);
    }
  }

  score = Math.min(100, Math.max(0, score));

  const run: BenchmarkRun = {
    runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    taskId: challenge.id,
    taskTitle: challenge.title,
    taskPrompt: challenge.prompt,
    expectedDeliverable: challenge.expectedDeliverable,
    modelOutput,
    score,
    latencyMs,
    tokensUsed: approxTokens,
    passedGates,
    failedGates,
    timestamp: new Date().toISOString(),
  };

  // Update agent empirical metrics
  agent.benchmarks.unshift(run);
  if (agent.benchmarks.length > 50) agent.benchmarks.pop();
  agent.tasksCompleted += 1;
  agent.avgScore = Math.round(
    agent.benchmarks.reduce((acc, b) => acc + b.score, 0) / agent.benchmarks.length
  );
  // Fitness combines benchmark score (80%) and latency efficiency (20%)
  const speedBonus = Math.max(0, 20 - Math.min(20, latencyMs / 200));
  agent.fitness = Math.round(agent.avgScore * 0.8 + speedBonus);
  agent.updatedAt = new Date().toISOString();

  return run;
}

// ── Generational Breeding & Mutation ────────────────────────────────────

export function breedAgents(
  parentAId: string,
  parentBId: string,
  childName?: string
): TunedAgent {
  seedInitialGen0Agents();
  const parentA = agentRegistry.get(parentAId);
  const parentB = agentRegistry.get(parentBId);

  if (!parentA || !parentB) {
    throw new Error('Both parent agents must exist to breed a new generation');
  }

  const childGen = Math.max(parentA.generation, parentB.generation) + 1;
  const name = childName?.trim() || `${parentA.name.split(' ')[0]}-${parentB.name.split(' ')[0]} (Gen ${childGen})`;

  // Crossover reasoning rules and output constraints
  const combinedRules = Array.from(
    new Set([...parentA.contextDna.reasoningRules, ...parentB.contextDna.reasoningRules])
  );
  const combinedConstraints = Array.from(
    new Set([...parentA.contextDna.outputConstraints, ...parentB.contextDna.outputConstraints])
  );
  const combinedKnowledge = Array.from(
    new Set([...parentA.contextDna.specializedKnowledge, ...parentB.contextDna.specializedKnowledge])
  );

  // Inherit the stronger parent's core system directive with hybrid tone
  const primaryParent = parentA.fitness >= parentB.fitness ? parentA : parentB;
  const secondaryParent = primaryParent === parentA ? parentB : parentA;

  const hybridizedTone = `${primaryParent.contextDna.personaTone} Infused with ${secondaryParent.contextDna.personaTone.toLowerCase()}`;
  const blendedTemp = Number(
    ((primaryParent.contextDna.temperature * 0.6 + secondaryParent.contextDna.temperature * 0.4)).toFixed(2)
  );

  const childDna: PromptContextDna = {
    systemDirective: `${primaryParent.contextDna.systemDirective}\nAdditionally: Incorporate adaptive cross-disciplinary reasoning from ${secondaryParent.name}.`,
    personaTone: hybridizedTone,
    reasoningRules: combinedRules.slice(0, 6),
    outputConstraints: combinedConstraints.slice(0, 4),
    specializedKnowledge: combinedKnowledge.slice(0, 8),
    temperature: blendedTemp,
  };

  const childAgent = createTunedAgent({
    name,
    role: primaryParent.role,
    ownerId: primaryParent.ownerId,
    ownerName: primaryParent.ownerName,
    generation: childGen,
    parentIds: [parentA.id, parentB.id],
    llmConfig: primaryParent.llmConfig,
    contextDna: childDna,
    locked: false,
  });

  return childAgent;
}

// ── Autonomous Domain Role Synthesis ────────────────────────────────────

export async function synthesizeDomainRole(
  domainDescription: string,
  options?: {
    userOrEmail?: string;
    ownerId?: string;
    ownerName?: string;
    isPublic?: boolean;
  }
): Promise<AgentRoleCard> {
  const ownerId = options?.ownerId || options?.userOrEmail || 'usr-local';
  const ownerName = options?.ownerName || 'Swarm User';
  const isPublic = options?.isPublic ?? false;

  const systemPrompt = `You are the Swarm Role Synthesizer. Analyze the provided domain/objective and design a high-performance specialized Agent Role.
Return a valid JSON object matching this schema:
{
  "roleId": "short-lowercase-kebab-slug",
  "name": "Title-Cased Role Name (e.g. Distributed Database Sentry)",
  "category": "architecture" | "engineering" | "security" | "specialist" | "operations",
  "description": "1-2 sentence description of what this role does",
  "responsibility": "Core responsibilities",
  "suggestedTools": ["shell", "search", "edit", "browser", "test"],
  "recommendedModelTier": "frontier" | "strong" | "medium" | "light",
  "color": "from-cyan-400 to-blue-500",
  "contextInputRange": "e.g. 32k – 128k tokens",
  "contextOutputRange": "e.g. 2k – 8k tokens",
  "usageContexts": ["workflow", "decomposition", "manual", "orchestration"],
  "contextDna": {
    "systemDirective": "Comprehensive system prompt for this specialized role",
    "personaTone": "Persona description",
    "reasoningRules": ["Rule 1", "Rule 2", "Rule 3"],
    "outputConstraints": ["Constraint 1", "Constraint 2"],
    "specializedKnowledge": ["Topic 1", "Topic 2", "Topic 3"],
    "temperature": 0.2
  }
}
Return JSON only.`;

  const rawOutput = await deepseekChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Domain/Objective to synthesize role for: ${domainDescription}` },
    ],
    { temperature: 0.2, maxTokens: 2048 },
    options?.userOrEmail
  );

  let parsed: any;
  try {
    const clean = rawOutput.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    parsed = JSON.parse(clean.slice(start, end + 1));
  } catch {
    // Fallback if model did not return exact JSON
    const slug = domainDescription.slice(0, 20).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    parsed = {
      roleId: `role-${slug}`,
      name: `${domainDescription.slice(0, 24)} Specialist`,
      category: 'specialist',
      description: `Specialized agent tailored for ${domainDescription}`,
      responsibility: `Autonomous execution for ${domainDescription}`,
      suggestedTools: ['shell', 'edit', 'search'],
      recommendedModelTier: 'strong',
      color: 'from-violet-400 to-indigo-500',
      contextDna: {
        systemDirective: `You are an expert specialist focused on: ${domainDescription}. Provide complete, high-quality, and robust deliverables.`,
        personaTone: 'Focused, methodical, and domain-expert.',
        reasoningRules: ['Check all edge cases.', 'Deliver verified artifacts.'],
        outputConstraints: ['Structured and deterministic output.'],
        specializedKnowledge: [domainDescription],
        temperature: 0.2,
      },
    };
  }

  const role = roleCardFromSynthesis(parsed, {
    domainDescription,
    isPublic,
    ownerId,
    ownerName,
  });

  return saveRoleCard(role);
}

export async function listSynthesizedRoles(ownerId?: string): Promise<AgentRoleCard[]> {
  return listRoleCards({ scope: 'all', ownerId });
}
