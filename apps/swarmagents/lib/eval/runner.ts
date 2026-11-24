// HarnessEvalRunner: executes a harness config across the benchmark suite
// in isolated run directories and aggregates the results.
//
// Isolation is a pluggable driver. The local driver creates a fresh temp
// directory per run and removes it afterwards — no run can see another
// run's files, and teardown is verified (a leftover directory is a hard
// error, not a silent leak). There is no Docker on this machine, so a
// DockerIsolation driver is a future implementation of the same interface:
// same create/destroy contract, container teardown instead of rm -rf.

import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  EvalRunMetrics,
  EvalTaskDef,
  EvalTrialResult,
  HarnessConfig,
} from "./types";
import { EVAL_SUITE } from "./suite";
import { MockReplayDriver, type AgentDriver, type GradingResult } from "./driver";

export interface IsolationDriver {
  /** Create an isolated directory for one task trial. */
  create(taskId: string, trial: number): Promise<string>;
  /** Destroy it. Must remove everything the run created. */
  destroy(dir: string): Promise<void>;
}

export class LocalTempIsolation implements IsolationDriver {
  constructor(private readonly root: string = os.tmpdir()) {}

  async create(taskId: string, trial: number): Promise<string> {
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return mkdtemp(path.join(this.root, `swarm-eval-${safe}-t${trial}-`));
  }

  async destroy(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RunSuiteOptions {
  tasks?: EvalTaskDef[];
  trialsPerTask?: number;
}

export interface HarnessEvalRunnerOptions {
  isolation?: IsolationDriver;
  driver?: AgentDriver;
}

export class HarnessEvalRunner {
  private readonly isolation: IsolationDriver;
  private readonly driver: AgentDriver;

  constructor(options: HarnessEvalRunnerOptions = {}) {
    this.isolation = options.isolation ?? new LocalTempIsolation();
    this.driver = options.driver ?? new MockReplayDriver();
  }

  /** Run one task trial in a fresh isolated directory. */
  async runTask(
    task: EvalTaskDef,
    config: HarnessConfig,
    trial: number
  ): Promise<{ result: EvalTrialResult; grading: GradingResult }> {
    const runDir = await this.isolation.create(task.id, trial);
    let outcome: { metrics: EvalRunMetrics; grading: GradingResult } | undefined;
    let runError: unknown;
    try {
      outcome = await this.driver.run(task, config, runDir);
    } catch (err) {
      runError = err;
    }
    // Teardown runs whether the driver succeeded or failed, and the
    // teardown check throws from here — never from a finally block, where
    // it would mask the run's own error.
    await this.isolation.destroy(runDir);
    const leftover = await access(runDir).then(
      () => true,
      () => false, // ENOENT: the directory is gone, as expected.
    );
    if (leftover) {
      throw new Error(
        `eval isolation teardown failed: ${runDir} still exists after destroy()`,
        { cause: runError },
      );
    }
    if (runError !== undefined) throw runError;
    const { metrics, grading } = outcome!;
    return {
      result: {
        taskId: task.id,
        bucket: task.bucket,
        configName: config.name,
        trial,
        metrics,
        grading,
      },
      grading,
    };
  }

  /** Run a whole suite (default: all 15 tasks) for one config. */
  async runSuite(
    config: HarnessConfig,
    options: RunSuiteOptions = {}
  ): Promise<EvalTrialResult[]> {
    const tasks = options.tasks ?? EVAL_SUITE;
    const trials = options.trialsPerTask ?? 3;
    const results: EvalTrialResult[] = [];
    for (const task of tasks) {
      for (let trial = 1; trial <= trials; trial++) {
        const { result } = await this.runTask(task, config, trial);
        results.push(result);
      }
    }
    return results;
  }
}
