import { GroqClient } from "./groqClient.js";
import { MiniOrchestrator, ExecutionResult } from "./orchestrator.js";
import { AstSlicer } from "./astSlicer.js";

export interface SwarmTask {
  filePath: string;
  instructionOrDiagnostic: string;
  startLine?: number;
  endLine?: number;
}

export class ParallelSwarmWorker {
  private orchestrator: MiniOrchestrator;

  constructor(orchestrator?: MiniOrchestrator) {
    this.orchestrator = orchestrator || new MiniOrchestrator();
  }

  /**
   * Dispatches multiple file repair turns simultaneously across distinct Groq keys in the pool.
   * If there are 4 tasks, 4 separate keys from the 14-key pool fire in parallel.
   */
  public async executeParallel(tasks: SwarmTask[]): Promise<ExecutionResult[]> {
    console.log(`[ParallelSwarmWorker] Spawning ${tasks.length} concurrent workers across Groq key pool...`);
    const t0 = Date.now();

    const promises = tasks.map((t, idx) => {
      const start = t.startLine ?? 1;
      const end = t.endLine ?? 80;
      return this.orchestrator.executeFileRepairTurn(t.filePath, t.instructionOrDiagnostic, start, end);
    });

    const results = await Promise.all(promises);
    const totalDuration = Date.now() - t0;
    const totalTokens = results.reduce((acc, r) => acc + r.tokensUsed, 0);

    console.log(
      `[ParallelSwarmWorker] All ${tasks.length} tasks completed in parallel in ${totalDuration}ms! Total tokens: ${totalTokens}.`
    );

    return results;
  }
}
