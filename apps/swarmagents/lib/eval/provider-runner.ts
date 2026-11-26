// ProviderEvalRunner: executes the scripted general-task suite across one or
// more providers in isolated directories, grades each trial with
// `node --test`, and aggregates per-provider summary rows.
//
// Isolation reuses the harness eval's `LocalTempIsolation` (a fresh mkdtemp
// per trial, removed and verified gone afterwards). Grading reuses
// `gradeRunDir`/`parseTap` so the metric pipeline is identical to the
// harness A/B eval. The only new pieces are provider-level aggregation and
// the multi-provider report table.

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gradeRunDir } from "./driver";
import { LocalTempIsolation, type IsolationDriver } from "./runner";
import { PROVIDER_EVAL_TASKS } from "./provider-tasks";
import { ScriptedProviderExecutor } from "./provider-executor";
import type { VmDriver, VmHandle } from "../vm/types";
import type {
  ProviderEvalReport,
  ProviderEvalTask,
  ProviderExecutor,
  ProviderReportRow,
  ProviderRunContext,
  ProviderRunMetrics,
  ProviderTrialResult,
} from "./provider-types";

export interface ProviderSpec {
  providerId: string;
  model: string;
}

/** Root inside a VM where eval trials are provisioned (desktop/manual runs). */
export const VM_EVAL_ROOT = "/workspace/.eval";

export interface ProviderEvalRunnerOptions {
  isolation?: IsolationDriver;
  executor?: ProviderExecutor;
  /**
   * When provided, the runner also provisions each trial into the VM under
   * `${VM_EVAL_ROOT}/<taskId>/<trial>` (setup files, then the executor's
   * delta) and verifies the VM holds the solved state. This exercises a
   * real desktop VM driver (FakeVmDriver in CI, DockerVmDriver locally).
   */
  vmDriver?: VmDriver;
}

export class ProviderEvalRunner {
  private readonly isolation: IsolationDriver;
  private readonly executor: ProviderExecutor;
  private readonly vmDriver?: VmDriver;

  constructor(options: ProviderEvalRunnerOptions = {}) {
    this.isolation = options.isolation ?? new LocalTempIsolation();
    this.executor = options.executor ?? new ScriptedProviderExecutor();
    this.vmDriver = options.vmDriver;
    if (this.vmDriver) {
      // Pre-flight: ensure the driver implements the file primitives the VM
      // provisioning relies on, so a misconfigured driver fails fast.
      const d = this.vmDriver;
      if (typeof d.writeFile !== "function" || typeof d.readFile !== "function") {
        throw new Error("ProviderEvalRunner: vmDriver must implement writeFile/readFile");
      }
    }
  }

  /** Run one task×provider trial in a fresh isolated directory. */
  async runTrial(
    task: ProviderEvalTask,
    provider: ProviderSpec,
    trial: number,
  ): Promise<{ trial: ProviderTrialResult; grading: { passed: number; failed: number; total: number } }> {
    const runDir = await this.isolation.create(`${task.id}-${provider.providerId}`, trial);
    let runError: unknown;
    let metrics: ProviderRunMetrics | undefined;
    let grading: { passed: number; failed: number; total: number } | undefined;

    try {
      // 1. Seed the starting workspace.
      await this.writeFiles(runDir, task.setupFiles);
      // 2. Let the executor work in it (scripted: returns a delta).
      const result = await this.executor.run(task, this.ctx(provider));
      // 3. Apply the executor's delta (write new/overwritten files, remove
      //    deleted paths).
      await this.writeFiles(runDir, result.files);
      await this.removeFiles(runDir, result.deleted ?? []);
      metrics = result.metrics;
      // 3b. When a VM driver is supplied, provision this trial into the VM
      //      and verify it ends in the solved state.
      if (this.vmDriver) {
        await this.provisionVm(task, provider, trial, result);
      }
      // 4. Lay down the grading verifier *after* the executor's delta so the
      //    solution can never clobber the test that grades it.
      await this.writeFiles(runDir, { [task.verifier.path]: task.verifier.content });
      // 5. Grade while the run dir is still present.
      grading = await gradeRunDir(runDir, task.verifier.path);
    } catch (err) {
      runError = err;
    }

    // Teardown runs whether the run succeeded or failed, and the leftover
    // check throws from here — never from a finally block, where it would
    // mask the run's own error.
    await this.isolation.destroy(runDir);
    const leftover = await access(runDir).then(
      () => true,
      () => false, // ENOENT: gone, as expected.
    );
    if (leftover) {
      throw new Error(`eval isolation teardown failed: ${runDir} still exists after destroy()`, {
        cause: runError,
      });
    }
    if (runError !== undefined) throw runError;

    const resolved = grading!.total > 0 && grading!.failed === 0;
    const partialScore = grading!.total === 0 ? 0 : grading!.passed / grading!.total;
    return {
      trial: {
        taskId: task.id,
        category: task.category,
        providerId: provider.providerId,
        model: provider.model,
        trial,
        resolved,
        partialScore,
        metrics: metrics!,
        grading: grading!,
      },
      grading: grading!,
    };
  }

  /** Run the whole suite across providers. */
  async runSuite(
    providers: ProviderSpec[],
    options: { tasks?: ProviderEvalTask[]; trialsPerTask?: number } = {},
  ): Promise<ProviderTrialResult[]> {
    const tasks = options.tasks ?? PROVIDER_EVAL_TASKS;
    const trials = options.trialsPerTask ?? 1;
    const results: ProviderTrialResult[] = [];
    for (const provider of providers) {
      for (const task of tasks) {
        for (let trial = 1; trial <= trials; trial++) {
          const { trial: t } = await this.runTrial(task, provider, trial);
          results.push(t);
        }
      }
    }
    return results;
  }

  /** Build per-provider summary rows from trial results. */
  summarize(results: ProviderTrialResult[]): ProviderEvalReport {
    const byProvider = new Map<string, ProviderTrialResult[]>();
    for (const r of results) {
      const key = `${r.providerId}/${r.model}`;
      const list = byProvider.get(key) ?? [];
      list.push(r);
      byProvider.set(key, list);
    }
    const rows: ProviderReportRow[] = [];
    for (const [key, group] of byProvider) {
      const [providerId, model] = key.split("/");
      const tasksRun = new Set(group.map((r) => r.taskId)).size;
      const total = group.length;
      const completed = group.filter((r) => r.resolved).length;
      rows.push({
        providerId,
        model,
        tasksRun,
        completionRate: total === 0 ? 0 : completed / total,
        meanTurns: mean(group.map((r) => r.metrics.totalTurns)),
        meanInputTokens: mean(group.map((r) => r.metrics.totalInputTokens)),
        meanOutputTokens: mean(group.map((r) => r.metrics.totalOutputTokens)),
        meanWallClockMs: mean(group.map((r) => r.metrics.wallClockMs)),
      });
    }
    rows.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model));
    return { rows, generatedAt: new Date().toISOString() };
  }

  private ctx(provider: ProviderSpec): ProviderRunContext {
    return { providerId: provider.providerId, model: provider.model };
  }

  /**
   * Provision one trial into the VM and verify it holds the solved state.
   * The trial root is `${VM_EVAL_ROOT}/<taskId>/<trial>`; the setup files
   * are written, the executor's delta is applied, and every expected final
   * file is read back and compared. A mismatch throws (the trial then
   * reports as an error), which surfaces a broken VM integration fast.
   */
  private async provisionVm(
    task: ProviderEvalTask,
    provider: ProviderSpec,
    trial: number,
    result: { files: Record<string, string>; deleted?: string[] },
  ): Promise<void> {
    const driver = this.vmDriver!;
    const handle: VmHandle = await driver.ensure(`${provider.providerId}-${provider.model}`);
    const root = `${VM_EVAL_ROOT}/${task.id}/${trial}`;

    const write = async (relative: string, content: string): Promise<void> => {
      const target = `${root}/${relative}`;
      await driver.writeFile(handle, target, content);
    };

    for (const [relative, content] of Object.entries(task.setupFiles)) {
      await write(relative, content);
    }
    for (const [relative, content] of Object.entries(result.files)) {
      await write(relative, content);
    }

    // Verify the final state: every solution file must be present and equal.
    for (const [relative, expected] of Object.entries(task.solution.files)) {
      const actual = await driver.readFile(handle, `${root}/${relative}`);
      if (actual !== expected) {
        throw new Error(
          `VM provisioning mismatch for ${task.id} trial ${trial} at ${relative}`,
        );
      }
    }
  }

  private async writeFiles(runDir: string, files: Record<string, string>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(runDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }

  private async removeFiles(runDir: string, relative: string[]): Promise<void> {
    for (const p of relative) {
      const target = path.join(runDir, p);
      if (target.startsWith(runDir + path.sep)) {
        await rm(target, { force: true });
      }
    }
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
