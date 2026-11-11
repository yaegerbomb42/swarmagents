/**
 * SELF-IMPROVER CORE — Immutable orchestration engine for autonomous self-improvement.
 *
 * This file is part of the IMMUTABLE CORE. It cannot be modified by the
 * autonomous system itself. It provides the loop, safety guards, and
 * coordination layer that allows the system to improve everything ELSE.
 *
 * Architecture:
 *   - Core (this file + safety/):   NEVER modified by AI
 *   - Mutable (app/, components/, lib/ except core/): AI can improve
 *   - Substrate (api routes, build config): AI can improve
 */

import { getMetricsCollector } from '../agentMetrics';
import { getCostTracker } from '../costTracker';
import { getMemoryPersistence } from '../memoryPersistence';

// ─── Configuration ──────────────────────────────────────────
const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT || '';
const AZURE_MODEL = process.env.AZURE_MODEL || 'DeepSeek-V4-Flash';
const AZURE_API_KEY = process.env.AZURE_API_KEY || '';

const PROJECT_ROOT = process.cwd();
const MUTABLE_DIRS = ['src/app', 'src/components', 'src/lib', 'public'];
const IMMUTABLE_PATTERNS = [
  /src\/lib\/core\//,
  /src\/lib\/engine-service\.ts/,
  /node_modules/,
  /\.git\//,
  /\.next\//,
  /package-lock\.json/,
];

// ─── Types ──────────────────────────────────────────────────
export interface ImprovementTask {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'ui' | 'backend' | 'api' | 'agent' | 'memory' | 'performance' | 'bugfix' | 'feature';
  title: string;
  description: string;
  targetFiles: string[];
  status: 'pending' | 'analyzing' | 'coding' | 'testing' | 'deploying' | 'done' | 'failed';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  subAgents: SubAgentResult[];
}

export interface SubAgentResult {
  role: string;
  task: string;
  output: string;
  tokensUsed: number;
  cost: number;
}

export interface SystemState {
  isRunning: boolean;
  currentTask: ImprovementTask | null;
  taskQueue: ImprovementTask[];
  completedTasks: ImprovementTask[];
  lastRunAt: number | null;
  totalIterations: number;
  totalTokensUsed: number;
  totalCost: number;
  currentCycle: number;
  errors: string[];
}

// ─── State ────────────────────────────────────────────────────
let systemState: SystemState = {
  isRunning: false,
  currentTask: null,
  taskQueue: [],
  completedTasks: [],
  lastRunAt: null,
  totalIterations: 0,
  totalTokensUsed: 0,
  totalCost: 0,
  currentCycle: 0,
  errors: [],
};

let loopInterval: ReturnType<typeof setInterval> | null = null;
const stateListeners = new Set<() => void>();

function emitState() {
  stateListeners.forEach(l => l());
}

// ─── Public API ─────────────────────────────────────────────
export function getSystemState(): SystemState {
  return { ...systemState };
}

export function subscribeState(cb: () => void) {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}

export async function startAutonomousLoop(intervalMs = 300000) {
  if (systemState.isRunning) return;
  systemState.isRunning = true;
  emitState();

  // Run immediately, then on interval
  runImprovementCycle();
  loopInterval = setInterval(runImprovementCycle, intervalMs);
}

export async function stopAutonomousLoop() {
  systemState.isRunning = false;
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  emitState();
}

export async function triggerSingleCycle() {
  return runImprovementCycle();
}

export function addExternalTask(task: Omit<ImprovementTask, 'id' | 'status' | 'createdAt' | 'subAgents'>) {
  const full: ImprovementTask = {
    ...task,
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    createdAt: Date.now(),
    subAgents: [],
  };
  systemState.taskQueue.push(full);
  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  systemState.taskQueue.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  emitState();
}

// ─── Core Loop ──────────────────────────────────────────────
async function runImprovementCycle() {
  systemState.currentCycle++;
  systemState.lastRunAt = Date.now();
  emitState();

  try {
    // Phase 1: Perceive — gather system state
    const perception = await perceive();

    // Phase 2: Plan — generate or select tasks
    const tasks = await plan(perception);

    // Phase 3: Act — execute highest priority task
    if (tasks.length > 0) {
      const task = tasks[0];
      systemState.currentTask = task;
      emitState();
      await executeTask(task);
    }

    // Phase 4: Reflect — log learnings
    await reflect(perception, tasks);

    systemState.totalIterations++;
  } catch (e: any) {
    const err = String(e?.message ?? e);
    systemState.errors.push(`${new Date().toISOString()}: ${err}`);
    if (systemState.errors.length > 50) systemState.errors.shift();
  } finally {
    systemState.currentTask = null;
    emitState();
  }
}

// ─── Phase 1: Perceive ──────────────────────────────────────
async function perceive() {
  const metrics = getMetricsCollector();
  const costs = getCostTracker();
  const persist = getMemoryPersistence();

  await persist.init();
  const savedState = await persist.loadState();

  const snapshot = metrics.getSystemSnapshot();
  const costStats = costs.getStats();

  return {
    timestamp: Date.now(),
    activeAgents: snapshot.global.activeAgents,
    tasksCompleted: snapshot.global.taskSuccessCount + snapshot.global.taskFailureCount,
    totalTokens: snapshot.global.totalTokens,
    totalCost: costStats.totalCost,
    uptime: snapshot.global.uptime,
    recentDecisions: snapshot.global.agentDecisions?.slice(-10) ?? [],
    toolUsage: snapshot.global.toolUsage ?? {},
    savedState,
    pendingTasks: systemState.taskQueue.length,
    completedTasks: systemState.completedTasks.length,
    recentErrors: systemState.errors.slice(-5),
  };
}

// ─── Phase 2: Plan ──────────────────────────────────────────
async function plan(perception: any): Promise<ImprovementTask[]> {
  // If we already have tasks queued, return the highest priority one
  if (systemState.taskQueue.length > 0) {
    const next = systemState.taskQueue.shift()!;
    return [next];
  }

  // Otherwise, ask the LLM to generate improvement tasks
  const prompt = buildPlanningPrompt(perception);
  const response = await callAzureLLM(prompt, 0.9, 4096);

  if (!response.ok) {
    // Fallback: generate a maintenance task
    return [generateMaintenanceTask(perception)];
  }

  const tasks = parseTasksFromResponse(response.content, perception);
  systemState.taskQueue.push(...tasks);
  emitState();

  return tasks.length > 0 ? [tasks[0]] : [generateMaintenanceTask(perception)];
}

function buildPlanningPrompt(perception: any): string {
  return `You are the SwarmAgents Self-Improvement Planner. Your job is to analyze the current system state and generate concrete improvement tasks.

## Current System State
- Active Agents: ${perception.activeAgents}
- Tasks Completed: ${perception.tasksCompleted}
- Total Tokens Used: ${perception.totalTokens}
- Total Cost: $${perception.totalCost.toFixed(4)}
- Pending Tasks: ${perception.pendingTasks}
- Completed Tasks: ${perception.completedTasks}
- Recent Errors: ${perception.recentErrors.length > 0 ? perception.recentErrors.join('; ') : 'none'}
- Recent Agent Decisions: ${perception.recentDecisions.length > 0 ? JSON.stringify(perception.recentDecisions) : 'none'}

## Available Code Areas
- UI: src/app/ pages, src/components/ React components
- Backend: src/app/api/ routes, src/lib/ utilities
- Agents: src/lib/ agent orchestration, task decomposition
- Memory: src/lib/ learning, persistence, metrics
- Build: next.config.ts, package.json, tsconfig.json

## Task Format
Respond with JSON array of tasks:
[
  {
    "priority": "critical|high|medium|low",
    "category": "ui|backend|api|agent|memory|performance|bugfix|feature",
    "title": "short task name",
    "description": "detailed what and why",
    "targetFiles": ["relative/path/to/file.ts"]
  }
]

Generate 1-3 high-impact improvement tasks. Be specific about what files to modify. Focus on:
1. Fixing any issues or errors
2. Improving UI/UX
3. Adding missing features
4. Performance optimizations
5. Better agent coordination
6. Memory system enhancements`;
}

function parseTasksFromResponse(content: string, perception: any): ImprovementTask[] {
  try {
    // Extract JSON from markdown code blocks or raw JSON
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\[[\s\S]*\])/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((t: any) => ({
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      priority: t.priority || 'medium',
      category: t.category || 'feature',
      title: t.title || 'Untitled task',
      description: t.description || '',
      targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles : [],
      status: 'pending' as const,
      createdAt: Date.now(),
      subAgents: [],
    }));
  } catch {
    return [];
  }
}

function generateMaintenanceTask(perception: any): ImprovementTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    priority: 'medium',
    category: 'performance',
    title: 'System health check and optimization',
    description: `Run a health check on the system. Tokens used: ${perception.totalTokens}. Tasks completed: ${perception.tasksCompleted}. Review and optimize any slow paths.`,
    targetFiles: ['src/lib/engine-service.ts'],
    status: 'pending',
    createdAt: Date.now(),
    subAgents: [],
  };
}

// ─── Phase 3: Execute ───────────────────────────────────────
async function executeTask(task: ImprovementTask) {
  const { readFile, applyMutation, validateBuild, isMutable, restoreFromBackup } = await import('./codeMutator');

  task.status = 'analyzing';
  task.startedAt = Date.now();
  emitState();

  // Read current contents of target files
  const fileContents: Record<string, string> = {};
  for (const filePath of task.targetFiles) {
    if (!isMutable(filePath)) {
      task.error = `Immutable file blocked: ${filePath}`;
      task.status = 'failed';
      systemState.completedTasks.push(task);
      emitState();
      return;
    }
    try {
      fileContents[filePath] = await readFile(filePath);
    } catch {
      fileContents[filePath] = ''; // New file
    }
  }

  // Spawn sub-agents for the task
  const analyzerPrompt = `Analyze the following task and determine the best approach.\n\nTask: ${task.title}\nDescription: ${task.description}\nTarget files:\n${Object.entries(fileContents).map(([f, c]) => `--- ${f} ---\n${c.slice(0, 3000)}`).join('\n\n')}\n\nWhat changes are needed and why?`;
  const analysis = await callAzureLLM(analyzerPrompt, 0.7, 4096);

  const coderPrompt = `You are the SwarmAgents Coder. Implement the following task by generating COMPLETE file contents.\n\nTask: ${task.title}\nDescription: ${task.description}\n\nCurrent file contents:\n${Object.entries(fileContents).map(([f, c]) => `--- ${f} ---\n${c.slice(0, 3000)}`).join('\n\n')}\n\nAnalysis: ${analysis.content || 'none'}\n\nRespond with a JSON object where keys are file paths and values are the COMPLETE new file contents (as strings). Example:\n{"src/app/page.tsx": "export default function Page() { return <div>Hello</div>; }"}\n\nOnly include files that need to change. Do NOT truncate — output the FULL file.`;
  const coderResponse = await callAzureLLM(coderPrompt, 0.8, 16384);

  task.status = 'coding';
  emitState();

  // Parse mutations from coder response
  let mutations: Record<string, string> = {};
  try {
    const jsonMatch = coderResponse.content.match(/```(?:json)?\s*([\s\S]*?)```/) || coderResponse.content.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : coderResponse.content.trim();
    mutations = JSON.parse(jsonStr);
  } catch (e) {
    task.error = `Failed to parse coder output as JSON: ${String(e)}`;
    task.status = 'failed';
    systemState.completedTasks.push(task);
    emitState();
    return;
  }

  // Apply mutations
  const appliedMutations: { filePath: string; ok: boolean; error?: string }[] = [];
  for (const [filePath, newContent] of Object.entries(mutations)) {
    if (!isMutable(filePath)) {
      appliedMutations.push({ filePath, ok: false, error: 'Immutable' });
      continue;
    }
    const result = await applyMutation({
      filePath,
      oldContent: fileContents[filePath],
      newContent: String(newContent),
      reason: task.description,
    });
    appliedMutations.push({ filePath, ok: result.ok, error: result.error });
  }

  task.status = 'testing';
  emitState();

  // Validate build
  const buildResult = await validateBuild();
  if (!buildResult.ok) {
    // Build failed — restore all backups
    for (const m of appliedMutations.filter(m => m.ok)) {
      await restoreFromBackup(m.filePath);
    }
    task.error = `Build failed — changes rolled back. Output: ${buildResult.output.slice(0, 500)}`;
    task.status = 'failed';
    systemState.completedTasks.push(task);
    emitState();
    return;
  }

  // Build passed — commit, push, and deploy
  try {
    const { execSync } = await import('child_process');
    const changedFiles = appliedMutations.filter(m => m.ok).map(m => m.filePath);
    if (changedFiles.length > 0) {
      execSync('git add -A', { cwd: PROJECT_ROOT });
      execSync(`git commit -m "auto: ${task.title}\n\n${task.description}\n\nFiles: ${changedFiles.join(', ')}"`, { cwd: PROJECT_ROOT });
      execSync('git push origin main', { cwd: PROJECT_ROOT });
      task.result = `Committed and pushed ${changedFiles.length} files. Build passed.`;

      // Deploy to production
      try {
        const deployOutput = execSync('../../deploy.sh swarmagents', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 180000 });
        task.result += ` Deployed successfully.`;
      } catch (deployErr: any) {
        task.error = `Deploy failed: ${String(deployErr?.message ?? deployErr)}`;
      }
    }
  } catch (e: any) {
    task.error = `Git operation failed: ${String(e?.message ?? e)}`;
  }

  task.status = 'done';
  task.completedAt = Date.now();
  systemState.completedTasks.push(task);
  emitState();
}

// ─── Phase 4: Reflect ─────────────────────────────────────
async function reflect(perception: any, tasks: ImprovementTask[]) {
  const persist = getMemoryPersistence();
  await persist.init();

  const reflection = {
    cycle: systemState.currentCycle,
    timestamp: Date.now(),
    perception,
    tasksExecuted: tasks.length,
    newTasksQueued: systemState.taskQueue.length,
    totalIterations: systemState.totalIterations,
  };

  // Save to shared memory
  await persist.saveSharedMemory(reflection);
}

// ─── Azure LLM Call ─────────────────────────────────────────
async function callAzureLLM(
  prompt: string,
  temperature = 0.8,
  max_tokens = 4096,
): Promise<{ content: string; ok: boolean; error?: string }> {
  const messages = [
    { role: 'system', content: 'You are the SwarmAgents self-improvement system. You analyze, plan, and generate code improvements.' },
    { role: 'user', content: prompt },
  ];

  try {
    const res = await fetch(`${AZURE_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AZURE_API_KEY}`,
      },
      body: JSON.stringify({
        model: AZURE_MODEL,
        messages,
        temperature,
        max_tokens,
        top_p: 0.1,
        presence_penalty: 0,
        frequency_penalty: 0,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { content: '', ok: false, error: `azure_${res.status}: ${txt.slice(0, 200)}` };
    }

    const j = await res.json();
    const content = j.choices?.[0]?.message?.content ?? '';
    return { content, ok: true };
  } catch (e: any) {
    return { content: '', ok: false, error: String(e?.message ?? e) };
  }
}
