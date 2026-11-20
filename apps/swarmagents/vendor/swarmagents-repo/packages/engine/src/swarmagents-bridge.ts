/**
 * SwarmAgents <-> Omnexx bridge.
 *
 * Runs a SwarmAgents task through the real Omnexx agent loop (`runAgentLoop`) on the Nemotron /
 * Mercury key clusters, inside a throwaway per-task workspace, and streams every step as
 * telemetry. The web control plane (apps/web /api/harness/task) loads the bundled build of this
 * file (dist/bridge.mjs) and forwards the telemetry to the browser over Server-Sent Events.
 *
 * Safety: the task gets file tools jailed to its own temp dir (read, list, write_file,
 * str_replace, todo). There is no shell tool: this runs behind a public web endpoint.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runAgentLoop, type LoopResult } from './agent/loop.js';
import { budgetSchema } from './config/schema.js';
import { realClock } from './core/clock.js';
import { EventLog, type OmnexxEvent } from './core/events.js';
import { RunStore } from './core/run-store.js';
import { buildClusters, clusterSummaries, type Env } from './llm/clusters.js';
import { ClusterRouter, type KeyCluster, type KeyClusterEvent } from './llm/key-cluster.js';
import type { ResolvedModel } from './providers/pricing.js';
import { PathJail } from './security/paths.js';
import { Redactor } from './security/redact.js';
import { writeFileTool, strReplaceTool } from './tools/edit.js';
import { listTool } from './tools/list.js';
import { readTool } from './tools/read.js';
import { toolSpec } from './tools/registry.js';
import { todoTool } from './tools/todo.js';
import type { Tool, ToolContext } from './tools/types.js';

export interface SwarmTaskDefinition {
  id: string;
  title: string;
  description: string;
  /** "nemotron", "mercury", "race" (both at once) or "auto" (default: fallback order). */
  provider?: string;
  model?: string;
  budget?: number;
  metadata?: Record<string, unknown>;
}

export interface SwarmTelemetryEvent {
  seq: number;
  ts: number;
  taskId: string;
  type: string;
  [key: string]: unknown;
}

export interface SwarmArtifact {
  path: string;
  content: string;
  bytes: number;
}

export interface SwarmHarnessExecutionResult {
  taskId: string;
  status: 'completed' | 'failed' | 'paused';
  stepsExecuted: number;
  costEstimateUsd: number;
  logs: string[];
  artifacts: string[];
  /** The agent's final answer. */
  finalText: string;
  files: SwarmArtifact[];
  end: LoopResult['end'] | 'error';
  error?: string;
  durationMs: number;
}

export interface ExecuteOptions {
  onEvent?: (e: SwarmTelemetryEvent) => void;
  signal?: AbortSignal;
  /** Where keys come from. Default `process.env`. */
  env?: Env;
  maxTurns?: number;
  maxTokens?: number;
  /** Wall-clock cap for the whole task. Default 5 minutes. */
  deadlineMs?: number;
  fetch?: typeof fetch;
  /** Keep the task workspace on disk (default: removed after the files are collected). */
  keepWorkspace?: boolean;
}

const SYSTEM = `You are Omnexx, the execution engine behind SwarmAgents. You work autonomously toward the user's goal.
You have a private, empty workspace and file tools (read, list, write_file, str_replace, todo). There is no shell.
Work in small, verified steps: plan briefly, write real files when the goal calls for code or documents, re-read what you wrote to check it, then stop.
Finish with a concise summary of what you did and which files you produced. Do not ask the user questions; make reasonable assumptions and state them.`;

const MAX_FILES = 40;
const MAX_FILE_BYTES = 64 * 1024;

/** Events from the Omnexx loop that are worth showing, mapped to compact telemetry. */
function mapLoopEvent(e: OmnexxEvent): Record<string, unknown> | undefined {
  switch (e.type) {
    case 'turn':
      return {
        type: 'step.model',
        turn: e['turn'],
        model: e['model'],
        provider: e['provider'],
        ms: e['ms'],
        stopReason: e['stopReason'],
        tokens: e['tokens'],
      };
    case 'agent.thinking':
      return { type: 'step.thinking', text: e['text'] };
    case 'tool.start':
      return { type: 'step.tool.start', tool: e['tool'], doing: e['doing'] };
    case 'tool.call':
      return {
        type: 'step.tool.done',
        tool: e['tool'],
        input: e['input'],
        isError: e['isError'],
        error: e['error'],
        bytes: e['bytes'],
      };
    default:
      if (/^(provider|budget|stuck|todo|control|router)\./.test(e.type)) {
        const { ts: _ts, runId: _r, cycle: _c, ...rest } = e;
        return { ...rest, type: `engine.${e.type}` };
      }
      return undefined;
  }
}

async function collectFiles(root: string): Promise<SwarmArtifact[]> {
  const out: SwarmArtifact[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        await walk(abs);
      } else if (ent.isFile()) {
        const size = (await stat(abs)).size;
        const content =
          size > MAX_FILE_BYTES
            ? `${(await readFile(abs, 'utf8')).slice(0, MAX_FILE_BYTES)}\n… [truncated]`
            : await readFile(abs, 'utf8');
        out.push({ path: relative(root, abs), content, bytes: size });
      }
    }
  };
  await walk(root);
  return out;
}

export class OmnexxSwarmBridge {
  constructor(private config: { workingDir?: string; defaultProvider?: string } = {}) {}

  /** The configured clusters (names, models, key counts; never keys). */
  static clusters(env: Env = process.env): ReturnType<typeof clusterSummaries> {
    return clusterSummaries(env);
  }

  public async executeTask(
    task: SwarmTaskDefinition,
    opts: ExecuteOptions = {},
  ): Promise<SwarmHarnessExecutionResult> {
    const started = Date.now();
    const env = opts.env ?? process.env;
    let seq = 0;
    const logs: string[] = [];
    const emit = (data: Record<string, unknown> & { type: string }): void => {
      const ev: SwarmTelemetryEvent = { ...data, seq: ++seq, ts: Date.now(), taskId: task.id };
      if (typeof data['message'] === 'string') logs.push(data['message']);
      opts.onEvent?.(ev);
    };
    const fail = (message: string, end: SwarmHarnessExecutionResult['end'] = 'error') => {
      emit({ type: 'task.error', message });
      return {
        taskId: task.id,
        status: 'failed' as const,
        stepsExecuted: 0,
        costEstimateUsd: 0,
        logs,
        artifacts: [],
        finalText: '',
        files: [],
        end,
        error: message,
        durationMs: Date.now() - started,
      };
    };

    const requested = (task.provider ?? this.config.defaultProvider ?? 'auto').toLowerCase();
    const onClusterEvent = (e: KeyClusterEvent): void => {
      if (e.type === 'race.start') return;
      emit({ ...e, type: `cluster.${e.type}` });
    };
    const clusters = buildClusters(env, {
      onEvent: onClusterEvent,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    if (clusters.length === 0)
      return fail(
        'No provider keys configured on the server: set NVIDIA_API_KEYS and/or INCEPTION_API_KEYS.',
      );
    // Auto leads with Mercury (fast, consistent); Nemotron is the deep pool behind it.
    const lead = requested === 'auto' || requested === 'race' ? (env['SWARM_LEAD_CLUSTER'] ?? 'mercury') : requested;
    const order = [...clusters].sort((a, b) => (a.name === lead ? -1 : b.name === lead ? 1 : 0));
    const router = new ClusterRouter(order, { race: requested === 'race' });
    const models: ResolvedModel[] = order.map((c) => ({
      provider: c.name,
      alias: c.name,
      id: task.model && c.name === requested ? task.model : c.model,
      price: {
        id: c.model,
        input: 0,
        output: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        cache_read: 0,
      } as ResolvedModel['price'],
    }));

    const base = await mkdtemp(join(this.config.workingDir ?? tmpdir(), 'omnexx-task-'));
    try {
      return await this.runInWorkspace(task, opts, { base, env, emit, fail, logs, order, router, models, requested, started });
    } finally {
      if (!opts.keepWorkspace) await rm(base, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runInWorkspace(
    task: SwarmTaskDefinition,
    opts: ExecuteOptions,
    s: {
      base: string;
      env: Env;
      emit: (data: Record<string, unknown> & { type: string }) => void;
      fail: (message: string) => SwarmHarnessExecutionResult;
      logs: string[];
      order: KeyCluster[];
      router: ClusterRouter;
      models: ResolvedModel[];
      requested: string;
      started: number;
    },
  ): Promise<SwarmHarnessExecutionResult> {
    const { base, env, emit, fail, logs, order, router, models, requested, started } = s;
    const workspace = join(base, 'workspace');
    const home = join(base, 'home');
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    // Mask every secret-shaped env value (and each key of a comma list) in events and errors.
    const listValues = Object.entries(env)
      .filter(([k, v]) => !!v && /_KEYS$/.test(k))
      .flatMap(([, v]) => (v as string).split(/[\s,;]+/));
    const redactor = Redactor.fromEnv(env as NodeJS.ProcessEnv, listValues);
    const store = new RunStore({ home, configHome: join(home, 'config') }, task.id);
    await store.init();
    const events = new EventLog(join(base, 'events.jsonl'), task.id, redactor, realClock);
    const unsubscribe = events.onEvent((e) => {
      const mapped = mapLoopEvent(e);
      if (mapped) emit(mapped as Record<string, unknown> & { type: string });
    });

    const tools: Tool[] = [readTool, listTool, writeFileTool, strReplaceTool, todoTool] as Tool[];
    let cmd = 0;
    const toolCtx: ToolContext = {
      jail: new PathJail(workspace),
      env: {},
      store,
      events,
      redactor,
      policy: { root: workspace, home, allowNetwork: false, extraDeny: [], scratch: [] },
      cycle: 1,
      maxCmdTimeoutMs: 30_000,
      notesMaxTokens: 2_000,
      today: new Date().toISOString().slice(0, 10),
      nextCommandId: () => `cmd-1-${String(++cmd)}`,
      edited: new Set(),
      reads: new Map(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    emit({
      type: 'task.started',
      title: task.title,
      clusters: order.map((c) => ({ name: c.name, model: c.model, keys: c.size })),
      mode: requested === 'race' ? 'race' : 'fallback',
      message: `[Omnexx] ${task.title} → ${order.map((c) => c.name).join(' → ')}`,
    });

    const maxTurns = Math.min(opts.maxTurns ?? 12, 40);
    let usd = 0;
    let result: LoopResult;
    try {
      result = await runAgentLoop(
        {
          system: [{ text: SYSTEM }],
          first: {
            role: 'user',
            content: [{ type: 'text', text: `# Goal: ${task.title}\n\n${task.description}` }],
          },
          tools: tools.map(toolSpec),
        },
        {
          provider: router,
          models,
          strategy: 'fallback',
          tools,
          toolCtx,
          budget: budgetSchema.parse({
            max_turns_per_cycle: maxTurns,
            max_tokens_per_cycle: 300_000,
            max_usd: Math.max(0.01, task.budget ?? 1),
          }),
          maxTokens: opts.maxTokens ?? 6_000,
          clock: realClock,
          events,
          purpose: 'main',
          taskId: () => task.id,
          cycle: () => 1,
          spentUsd: () => usd,
          onUsage: async (_u, cost) => {
            usd += cost;
          },
          control: async () => (opts.signal?.aborted ? 'stop-now' : 'continue'),
          retry: { baseDelayMs: 500, maxDelayMs: 4_000, giveUpAfterMs: 60_000 },
          ...(opts.signal ? { signal: opts.signal } : {}),
          deadlineMs: Date.now() + (opts.deadlineMs ?? 5 * 60_000),
        },
      );
    } catch (err) {
      return fail(err instanceof Error ? redactor.text(err.message) : 'engine error');
    } finally {
      unsubscribe();
    }
    const files = await collectFiles(workspace);
    const status: SwarmHarnessExecutionResult['status'] =
      result.end === 'done'
        ? 'completed'
        : result.end === 'stop' || result.end === 'stop-now' || result.end === 'rounds_spent'
          ? 'paused'
          : 'failed';
    const out: SwarmHarnessExecutionResult = {
      taskId: task.id,
      status,
      stepsExecuted: result.turns,
      costEstimateUsd: result.usd,
      logs,
      artifacts: files.map((f) => f.path),
      finalText: result.finalText,
      files,
      end: result.end,
      ...(result.detail ? { error: result.detail } : {}),
      durationMs: Date.now() - started,
    };
    emit({
      type: 'task.done',
      status: out.status,
      end: out.end,
      turns: out.stepsExecuted,
      usd: out.costEstimateUsd,
      finalText: out.finalText,
      files: out.files,
      durationMs: out.durationMs,
      keyStats: router.clusters.map((c) => ({ cluster: c.name, keys: c.stats() })),
    });
    return out;
  }
}
