import type { ContentBlock } from '../../providers/types.js';

export type ToolUseCall = Extract<ContentBlock, { type: 'tool_use' }>;
export type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

export type ToolCategory = 'READ_PARALLEL' | 'MUTATE_SERIAL' | 'RISKY_CHECKPOINT';

/**
 * Standard tool classification map.
 * Read-only discovery tools can execute concurrently in parallel waves.
 * Mutating or shell operations require serial barrier synchronization.
 */
export const TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  // Read-parallel
  read: 'READ_PARALLEL',
  read_file: 'READ_PARALLEL',
  search: 'READ_PARALLEL',
  grep: 'READ_PARALLEL',
  glob: 'READ_PARALLEL',
  list: 'READ_PARALLEL',
  list_dir: 'READ_PARALLEL',
  view_symbol: 'READ_PARALLEL',
  outline: 'READ_PARALLEL',
  read_symbol: 'READ_PARALLEL',
  recall: 'READ_PARALLEL',
  context: 'READ_PARALLEL',
  running_context: 'READ_PARALLEL',
  query_artifact: 'READ_PARALLEL',
  repl_projection: 'READ_PARALLEL',
  read_log: 'READ_PARALLEL',

  // Mutate-serial
  write_file: 'MUTATE_SERIAL',
  edit_file: 'MUTATE_SERIAL',
  str_replace: 'MUTATE_SERIAL',
  multi_edit: 'MUTATE_SERIAL',
  replace_lines: 'MUTATE_SERIAL',
  todo: 'MUTATE_SERIAL',
  define_contract: 'MUTATE_SERIAL',
  remember: 'MUTATE_SERIAL',
  task: 'MUTATE_SERIAL',

  // Risky checkpoint
  bash: 'RISKY_CHECKPOINT',
  delete_file: 'RISKY_CHECKPOINT',
};

export function classifyTool(toolName: string): ToolCategory {
  return TOOL_CATEGORIES[toolName] ?? 'MUTATE_SERIAL';
}

export interface ScheduledToolCall {
  originalIndex: number;
  call: ToolUseCall;
  category: ToolCategory;
}

export interface ExecutionWave {
  waveIndex: number;
  category: ToolCategory;
  isParallel: boolean;
  calls: ScheduledToolCall[];
}

/**
 * Groups a sequence of tool calls into execution waves.
 * Contiguous READ_PARALLEL calls are batched into a single concurrent wave.
 * MUTATE_SERIAL and RISKY_CHECKPOINT calls form isolated serial waves (barriers).
 */
export function buildExecutionWaves(toolCalls: readonly ToolUseCall[]): ExecutionWave[] {
  const waves: ExecutionWave[] = [];
  let currentParallelCalls: ScheduledToolCall[] = [];

  const flushParallel = () => {
    if (currentParallelCalls.length > 0) {
      waves.push({
        waveIndex: waves.length,
        category: 'READ_PARALLEL',
        isParallel: true,
        calls: [...currentParallelCalls],
      });
      currentParallelCalls = [];
    }
  };

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call) continue;
    const category = classifyTool(call.name);

    if (category === 'READ_PARALLEL') {
      currentParallelCalls.push({
        originalIndex: i,
        call,
        category,
      });
    } else {
      // Barrier encountered: flush previous parallel batch
      flushParallel();
      // Add serial barrier wave
      waves.push({
        waveIndex: waves.length,
        category,
        isParallel: false,
        calls: [{ originalIndex: i, call, category }],
      });
    }
  }

  flushParallel();
  return waves;
}

export interface SchedulerOptions {
  maxConcurrency?: number;
  signal?: AbortSignal;
}

export type ToolExecutor = (call: ToolUseCall, signal: AbortSignal) => Promise<ToolResultBlock>;

/**
 * Race an executor promise against the turn's abort signal. An executor that
 * ignores the signal and never settles would otherwise hang the wave forever
 * (Promise.allSettled waits on it); the race lets the wave synthesize a
 * cancellation envelope and move on. The abort listener is removed once the
 * race settles, and racing attaches a rejection handler to the executor
 * promise, so a late settlement can never surface as an unhandled rejection.
 * An executor that already resolved before the abort fired still wins the race,
 * so a tool that triggers the interrupt and then returns keeps its real result.
 */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  // The abort reason may be any value (a string, an Error, ...); the race must
  // reject with an Error so callers can treat it as a failure, not a bare value.
  const abortError = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('aborted');
  let onAbort: () => void = () => undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    onAbort = () => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Concurrently executes tool waves while strictly preserving the model's original
 * call order in the resulting tool_result envelopes.
 *
 * If an abort or steering interrupt occurs, in-flight or pending calls are safely
 * synthesized with deterministic cancellation results to maintain provider call/result pairing.
 */
export async function executeToolWaves(
  waves: readonly ExecutionWave[],
  totalCalls: number,
  executor: ToolExecutor,
  options: SchedulerOptions = {},
): Promise<ToolResultBlock[]> {
  const rawConcurrency = options.maxConcurrency;
  const maxConcurrency =
    typeof rawConcurrency === 'number' && Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.floor(rawConcurrency)
      : 4;
  const orderedResults: (ToolResultBlock | undefined)[] = [];
  const signal = options.signal;

  for (const wave of waves) {
    if (signal?.aborted) {
      // If already aborted, synthesize results for all remaining calls
      for (const scheduled of wave.calls) {
        orderedResults[scheduled.originalIndex] = {
          type: 'tool_result',
          toolUseId: scheduled.call.id,
          content: '[Tool execution skipped: previous tool failed or turn interrupted]',
          isError: true,
        };
      }
      continue;
    }

    if (wave.isParallel) {
      // Parallel wave with bounded concurrency limiter
      let nextIdx = 0;
      const workerCount = Math.min(maxConcurrency, wave.calls.length);

      const runWorker = async () => {
        while (nextIdx < wave.calls.length) {
          if (signal?.aborted) break;
          const currentCall = wave.calls[nextIdx++];
          if (!currentCall) break;

          try {
            const res = await withAbort(
              executor(currentCall.call, signal ?? new AbortController().signal),
              signal,
            );
            orderedResults[currentCall.originalIndex] = res;
          } catch (err) {
            // An abort that beat the executor to the finish line is a skip, not an
            // executor error: the tool never got to answer.
            orderedResults[currentCall.originalIndex] =
              signal?.aborted === true
                ? {
                    type: 'tool_result',
                    toolUseId: currentCall.call.id,
                    content: '[Tool execution skipped: previous tool failed or turn interrupted]',
                    isError: true,
                  }
                : {
                    type: 'tool_result',
                    toolUseId: currentCall.call.id,
                    content: `Error executing tool ${currentCall.call.name}: ${err instanceof Error ? err.message : String(err)}`,
                    isError: true,
                  };
          }
        }
      };

      const workers = Array.from({ length: workerCount }, () => runWorker());
      await Promise.allSettled(workers);
    } else {
      // Serial barrier wave
      const scheduled = wave.calls[0];
      if (scheduled) {
        try {
          const res = await withAbort(
            executor(scheduled.call, signal ?? new AbortController().signal),
            signal,
          );
          orderedResults[scheduled.originalIndex] = res;
        } catch (err) {
          // An abort that beat the executor to the finish line is a skip, not an
          // executor error: the tool never got to answer.
          orderedResults[scheduled.originalIndex] =
            signal?.aborted === true
              ? {
                  type: 'tool_result',
                  toolUseId: scheduled.call.id,
                  content: '[Tool execution skipped: previous tool failed or turn interrupted]',
                  isError: true,
                }
              : {
                  type: 'tool_result',
                  toolUseId: scheduled.call.id,
                  content: `Error executing tool ${scheduled.call.name}: ${err instanceof Error ? err.message : String(err)}`,
                  isError: true,
                };
        }
      }
    }
  }

  // Build index -> original call lookup to guarantee exact toolUseId preservation
  const callMap = new Map<number, ToolUseCall>();
  for (const wave of waves) {
    for (const scheduled of wave.calls) {
      callMap.set(scheduled.originalIndex, scheduled.call);
    }
  }

  // Final invariant check: fill any missing slots with synthetic cancellation results
  // and guarantee strict toolUseId matching with the caller's tool_use blocks.
  const effectiveTotal = Math.max(
    totalCalls,
    ...Array.from(callMap.keys()).map((k) => k + 1),
    orderedResults.length,
  );

  const finalized: ToolResultBlock[] = [];
  for (let i = 0; i < effectiveTotal; i++) {
    const existing = orderedResults[i];
    const originalCall = callMap.get(i);
    const targetId = originalCall?.id ?? existing?.toolUseId ?? `unknown-${String(i)}`;

    // `existing` is typed ToolResultBlock | undefined, so the type check is
    // redundant: a defined entry is always a tool_result envelope.
    if (existing !== undefined) {
      finalized.push({
        ...existing,
        toolUseId: targetId,
      });
    } else {
      finalized.push({
        type: 'tool_result',
        toolUseId: targetId,
        content: '[Tool execution skipped: previous tool failed or turn interrupted]',
        isError: true,
      });
    }
  }

  return finalized;
}
