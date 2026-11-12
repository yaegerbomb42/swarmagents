import type { LucideIcon } from 'lucide-react';
import {
  Cpu,
  Code2,
  CheckCircle2,
  Search,
  Bug,
  Globe,
  TestTube,
  FileText,
  Shield,
  BarChart3,
  Package,
  GitMerge,
  Rocket,
  Eye,
  Zap,
  Server,
  Users,
  Sliders,
  Minimize2,
  ListChecks,
  ShieldCheck,
} from 'lucide-react';

export interface AgentRole {
  id: string;
  name: string;
  icon: LucideIcon;
  description: string;
  responsibility: string;
  tools: string[];
  model_tier: 'frontier' | 'strong' | 'medium' | 'light';
  color: string;
}

/**
 * The 21 selectable agent archetypes. Team Mode adds two orchestration roles
 * (planner, reviewer) in TEAM_ROLES below — they are not archetypes a user
 * picks for a normal sub-agent, so they stay out of this inventory.
 */
export const AGENT_ROLES: AgentRole[] = [
  {
    id: 'architect',
    name: 'Architect',
    icon: Cpu,
    description: 'Designs system architecture, decomposes goals into task trees, and plans execution strategy.',
    responsibility: 'High-level planning, dependency mapping, risk assessment, technology selection.',
    tools: ['shell', 'search', 'edit'],
    model_tier: 'frontier',
    color: 'from-cyan-400 to-blue-500',
  },
  {
    id: 'implementer',
    name: 'Implementer',
    icon: Code2,
    description: 'Writes production code, implements features, and builds components per architectural specs.',
    responsibility: 'Code generation, file creation, API implementation, database schema design.',
    tools: ['shell', 'edit', 'search'],
    model_tier: 'strong',
    color: 'from-emerald-400 to-teal-500',
  },
  {
    id: 'verifier',
    name: 'Verifier',
    icon: CheckCircle2,
    description: 'Validates acceptance criteria, runs tests, and ensures deliverables meet quality standards.',
    responsibility: 'Test execution, acceptance criteria checking, quality gates, regression validation.',
    tools: ['shell', 'test', 'search'],
    model_tier: 'strong',
    color: 'from-violet-400 to-purple-500',
  },
  {
    id: 'researcher',
    name: 'Researcher',
    icon: Search,
    description: 'Conducts codebase analysis, API research, and gathers context for informed decision-making.',
    responsibility: 'Codebase exploration, documentation review, API research, dependency analysis.',
    tools: ['search', 'browser', 'shell'],
    model_tier: 'strong',
    color: 'from-amber-400 to-orange-500',
  },
  {
    id: 'debugger',
    name: 'Debugger',
    icon: Bug,
    description: 'Diagnoses runtime errors, fixes bugs, and resolves integration failures.',
    responsibility: 'Error analysis, stack trace investigation, root cause identification, hotfix implementation.',
    tools: ['shell', 'search', 'edit'],
    model_tier: 'strong',
    color: 'from-rose-400 to-red-500',
  },
  {
    id: 'browser-agent',
    name: 'Browser Agent',
    icon: Globe,
    description: 'Automates web browsers for UI testing, scraping, and web-based workflows.',
    responsibility: 'Web navigation, form filling, data extraction, visual regression testing.',
    tools: ['browser', 'shell', 'search'],
    model_tier: 'medium',
    color: 'from-sky-400 to-cyan-500',
  },
  {
    id: 'qa-engineer',
    name: 'QA Engineer',
    icon: TestTube,
    description: 'Writes and maintains comprehensive test suites including unit, integration, and E2E tests.',
    responsibility: 'Test planning, test case generation, coverage analysis, flaky test remediation.',
    tools: ['shell', 'test', 'edit'],
    model_tier: 'medium',
    color: 'from-pink-400 to-rose-500',
  },
  {
    id: 'security-auditor',
    name: 'Security Auditor',
    icon: Shield,
    description: 'Audits code for vulnerabilities, secrets leakage, and OWASP compliance.',
    responsibility: 'Security scanning, dependency vulnerability checks, secret detection, compliance review.',
    tools: ['search', 'shell', 'browser'],
    model_tier: 'frontier',
    color: 'from-red-400 to-rose-500',
  },
  {
    id: 'documentation-writer',
    name: 'Documentation Writer',
    icon: FileText,
    description: 'Generates README files, API docs, inline comments, and architectural documentation.',
    responsibility: 'Documentation generation, changelog maintenance, API reference writing, onboarding guides.',
    tools: ['edit', 'search', 'shell'],
    model_tier: 'medium',
    color: 'from-indigo-400 to-blue-500',
  },
  {
    id: 'devops-engineer',
    name: 'DevOps Engineer',
    icon: Server,
    description: 'Manages Docker, CI/CD pipelines, deployment scripts, and infrastructure as code.',
    responsibility: 'Containerization, pipeline configuration, deployment automation, environment management.',
    tools: ['shell', 'edit', 'search'],
    model_tier: 'strong',
    color: 'from-slate-400 to-gray-500',
  },
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    icon: BarChart3,
    description: 'Analyzes telemetry data, performance metrics, and generates actionable insights.',
    responsibility: 'Metrics analysis, performance profiling, data visualization, trend identification.',
    tools: ['shell', 'search', 'browser'],
    model_tier: 'medium',
    color: 'from-teal-400 to-emerald-500',
  },
  {
    id: 'product-manager',
    name: 'Product Manager',
    icon: Users,
    description: 'Translates user requirements into actionable tasks and prioritizes the backlog.',
    responsibility: 'Requirement analysis, task prioritization, scope management, stakeholder communication.',
    tools: ['search', 'edit'],
    model_tier: 'frontier',
    color: 'from-yellow-400 to-amber-500',
  },
  {
    id: 'ux-critic',
    name: 'UX Critic',
    icon: Eye,
    description: 'Reviews UI/UX consistency, accessibility compliance, and design system adherence.',
    responsibility: 'UI review, accessibility auditing, design system enforcement, user experience evaluation.',
    tools: ['browser', 'search', 'edit'],
    model_tier: 'medium',
    color: 'from-fuchsia-400 to-pink-500',
  },
  {
    id: 'performance-optimizer',
    name: 'Performance Optimizer',
    icon: Zap,
    description: 'Identifies and resolves performance bottlenecks in code, queries, and infrastructure.',
    responsibility: 'Profiling, query optimization, caching strategy, memory leak detection, latency reduction.',
    tools: ['shell', 'search', 'edit'],
    model_tier: 'strong',
    color: 'from-lime-400 to-green-500',
  },
  {
    id: 'dependency-manager',
    name: 'Dependency Manager',
    icon: Package,
    description: 'Manages package dependencies, updates, and resolves version conflicts.',
    responsibility: 'Dependency auditing, version updates, conflict resolution, lockfile management.',
    tools: ['shell', 'search', 'edit'],
    model_tier: 'light',
    color: 'from-stone-400 to-neutral-500',
  },
  {
    id: 'merge-resolver',
    name: 'Merge Resolver',
    icon: GitMerge,
    description: 'Resolves merge conflicts, rebases branches, and maintains git history hygiene.',
    responsibility: 'Conflict resolution, branch management, rebase operations, commit history cleanup.',
    tools: ['shell', 'search', 'edit'],
    model_tier: 'medium',
    color: 'from-orange-400 to-amber-500',
  },
  {
    id: 'test-writer',
    name: 'Test Writer',
    icon: TestTube,
    description: 'Generates comprehensive test coverage for existing and new code paths.',
    responsibility: 'Unit test generation, integration test writing, fixture creation, mock setup.',
    tools: ['edit', 'shell', 'search'],
    model_tier: 'medium',
    color: 'from-cyan-400 to-teal-500',
  },
  {
    id: 'code-migrator',
    name: 'Code Migrator',
    icon: Code2,
    description: 'Handles code migrations, refactoring, and framework upgrades across the codebase.',
    responsibility: 'Migration planning, automated refactoring, breaking change handling, deprecation management.',
    tools: ['shell', 'edit', 'search'],
    model_tier: 'strong',
    color: 'from-violet-400 to-indigo-500',
  },
  {
    id: 'release-engineer',
    name: 'Release Engineer',
    icon: Rocket,
    description: 'Manages release cycles, versioning, changelogs, and production deployments.',
    responsibility: 'Release coordination, version bumping, changelog generation, deployment verification.',
    tools: ['shell', 'edit', 'search'],
    model_tier: 'medium',
    color: 'from-green-400 to-emerald-500',
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    icon: Sliders,
    description: 'Coordinates all agents, monitors execution, and intervenes when agents get stuck or drift.',
    responsibility: 'Agent coordination, progress monitoring, intervention decisions, resource allocation.',
    tools: ['shell', 'search'],
    model_tier: 'frontier',
    color: 'from-cyan-400 to-teal-500',
  },
  {
    id: 'context-condenser',
    name: 'Context Condenser',
    icon: Minimize2,
    description:
      'Compresses 262k–1M token context into a 4–8k professional briefing for downstream agents — Antigravity/Cursor condensation format.',
    responsibility:
      'Session history compression, decision preservation, open-thread tracking, orchestration handoff briefings.',
    tools: ['search', 'edit', 'memory'],
    model_tier: 'frontier',
    color: 'from-fuchsia-400 to-violet-600',
  },
];

/**
 * Team Mode orchestration roles. They are roles in this registry (same shape,
 * same helpers) but not selectable archetypes, so they live outside
 * AGENT_ROLES and its inventory.
 */
export const TEAM_ROLES: AgentRole[] = [
  {
    id: 'planner',
    name: 'Planner',
    icon: ListChecks,
    description: 'Turns one goal into a small ordered task list, then hands each task to a matching role.',
    responsibility: 'Goal decomposition, task ordering, role assignment, acceptance criteria per task.',
    tools: ['read', 'search', 'plan'],
    model_tier: 'frontier',
    color: 'from-cyan-400 to-sky-500',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    icon: ShieldCheck,
    description: 'Checks each finished result against its task, then merges it or sends it back with notes.',
    responsibility: 'Acceptance review, rework notes, merge gating, final integration.',
    tools: ['read', 'test', 'search', 'merge'],
    model_tier: 'strong',
    color: 'from-violet-400 to-fuchsia-500',
  },
];

export const ALL_AGENT_ROLES: AgentRole[] = [...AGENT_ROLES, ...TEAM_ROLES];

export function getAgentRoleById(id: string): AgentRole | undefined {
  return ALL_AGENT_ROLES.find((r) => r.id === id);
}

export function formatRoleLabel(id: string): string {
  return getAgentRoleById(id)?.name ?? id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function defaultDirectiveForRole(roleId: string): string {
  if (roleId === 'context-condenser') {
    return `You are the Context Condenser. Compress 262k–1M tokens into a 4–8k briefing with sections: Mission, Key Decisions, Active Constraints, File Map, Open Threads, Recent Tool Activity, Next Actions. Never hallucinate. Preserve exact identifiers.`;
  }
  const role = getAgentRoleById(roleId);
  if (!role) {
    return 'You are a specialized swarm agent. Complete assigned tasks with measurable deliverables.';
  }
  return `You are the SwarmAgents ${role.name}. ${role.description} Focus: ${role.responsibility}`;
}

export const TIER_LABELS: Record<AgentRole['model_tier'], string> = {
  frontier: 'Frontier',
  strong: 'Strong',
  medium: 'Medium',
  light: 'Light',
};

export const TIER_BADGE_CLASS: Record<AgentRole['model_tier'], string> = {
  frontier: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  strong: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  medium: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  light: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
};

