import { GroqClient } from "./groqClient.js";
import { ContextGovernor } from "./contextGovernor.js";
import { AstSlicer } from "./astSlicer.js";
import { LogCondenser } from "./logCondenser.js";
import { StateEngine } from "./stateEngine.js";
import { AutoLocator, LocatedTarget } from "./autoLocator.js";
import { ChatHistoryTool } from "./chatHistoryTool.js";
import { CurrentTrajectoryTool } from "./currentTrajectoryTool.js";
import { DependencyRadarTool } from "./dependencyRadarTool.js";
import { execSync } from "child_process";

export interface ExecutionResult {
  success: boolean;
  message: string;
  filesChanged: string[];
  tokensUsed: number;
}

export class MiniOrchestrator {
  public client: GroqClient;
  public condenser: LogCondenser;
  public stateEngine: StateEngine;
  public chatHistory: ChatHistoryTool;
  public trajectory: CurrentTrajectoryTool;

  constructor(workDir: string = process.cwd()) {
    this.client = new GroqClient();
    this.condenser = new LogCondenser(this.client);
    this.stateEngine = new StateEngine(workDir);
    this.chatHistory = new ChatHistoryTool(this.client, workDir);
    this.trajectory = new CurrentTrajectoryTool(workDir);
  }

  public getState(): StateEngine {
    return this.stateEngine;
  }

  /**
   * Auto-locates candidate files from natural language description.
   */
  public locateTargets(naturalLanguageQuery: string): LocatedTarget[] {
    return AutoLocator.locate(naturalLanguageQuery);
  }

  /**
   * Scans downstream dependents for ripple effects before editing.
   */
  public scanDownstream(symbolName: string) {
    return DependencyRadarTool.scanDependents(symbolName);
  }

  /**
   * Executes a command in the workspace and catches error output,
   * automatically compressing it through LogCondenser if it blows up.
   */
  public async runCommand(cmd: string): Promise<{ success: boolean; output: string }> {
    try {
      const stdout = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
      return { success: true, output: stdout };
    } catch (err: any) {
      const rawErr = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || "");
      const condensed = await this.condenser.condenseLog(rawErr);
      return { success: false, output: condensed };
    }
  }

  /**
   * Performs an atomic 8k repair turn on a single target file.
   * Completely stateless: No conversation history carried over.
   */
  public async executeFileRepairTurn(
    filePath: string,
    diagnosticError: string,
    targetStartLine: number = 1,
    targetEndLine: number = 80
  ): Promise<ExecutionResult> {
    const step = this.stateEngine.incrementStep();
    const slice = AstSlicer.readSlice(filePath, targetStartLine, targetEndLine);
    const stateMemory = this.stateEngine.toContextMemoryString();

    const systemPrompt = ContextGovernor.getMicroSystemPrompt(
      this.stateEngine.getState().goal,
      this.stateEngine.getState().contractInvariants.join("; ")
    );

    const userPrompt = [
      `TARGET FILE: ${filePath} (Lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines})`,
      `DIAGNOSTIC ERROR / REQUIREMENT:`,
      diagnosticError,
      ``,
      `FILE SLICE:`,
      slice.content,
      ``,
      `INSTRUCTION: Provide the exact SEARCH text and REPLACE text to apply a surgical patch.`,
      `Respond in strict JSON format:`,
      `{`,
      `  "search": "exact code from slice to replace",`,
      `  "replace": "replacement code",`,
      `  "invariantLearned": "short rule/type invariant to record (optional)"`,
      `}`,
    ].join("\n");

    const { safePayload } = ContextGovernor.fitWithinBudget(systemPrompt, stateMemory, userPrompt);

    const completion = await this.client.chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: `CURRENT MEMORY:\n${stateMemory}` },
        { role: "user", content: safePayload },
      ],
      {
        model: this.client.defaultModel,
        response_format: { type: "json_object" },
        temperature: 0.1,
      }
    );

    try {
      const parsed = JSON.parse(completion.content);
      if (parsed.search && parsed.replace !== undefined) {
        AstSlicer.applySlicePatch(filePath, parsed.search, parsed.replace);
        this.stateEngine.recordTouchedFile(filePath);

        if (parsed.invariantLearned) {
          this.stateEngine.addInvariant(parsed.invariantLearned);
        }

        return {
          success: true,
          message: `Successfully applied surgical patch to ${filePath}`,
          filesChanged: [filePath],
          tokensUsed: completion.usage?.total_tokens || 0,
        };
      } else {
        return {
          success: false,
          message: "Model did not return valid search/replace JSON keys.",
          filesChanged: [],
          tokensUsed: completion.usage?.total_tokens || 0,
        };
      }
    } catch (parseErr: any) {
      return {
        success: false,
        message: `Failed to parse patch JSON: ${parseErr.message}`,
        filesChanged: [],
        tokensUsed: completion.usage?.total_tokens || 0,
      };
    }
  }
}
