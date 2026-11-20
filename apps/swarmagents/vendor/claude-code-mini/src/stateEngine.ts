import * as fs from "fs";
import * as path from "path";

export interface TaskState {
  goal: string;
  contractInvariants: string[];
  touchedFiles: string[];
  pendingQueue: string[];
  lastError: string | null;
  stepCount: number;
}

export class StateEngine {
  private stateFilePath: string;
  private state: TaskState;

  constructor(workDir: string = process.cwd()) {
    this.stateFilePath = path.join(workDir, ".claude_mini_state.json");
    this.state = this.loadState();
  }

  private loadState(): TaskState {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, "utf-8");
        return JSON.parse(raw);
      } catch {}
    }

    return {
      goal: "",
      contractInvariants: [],
      touchedFiles: [],
      pendingQueue: [],
      lastError: null,
      stepCount: 0,
    };
  }

  public save(): void {
    fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  public reset(newGoal: string): void {
    this.state = {
      goal: newGoal,
      contractInvariants: [],
      touchedFiles: [],
      pendingQueue: [],
      lastError: null,
      stepCount: 0,
    };
    this.save();
  }

  public getState(): TaskState {
    return this.state;
  }

  public addInvariant(invariant: string): void {
    if (!this.state.contractInvariants.includes(invariant)) {
      this.state.contractInvariants.push(invariant);
      this.save();
    }
  }

  public recordTouchedFile(file: string): void {
    if (!this.state.touchedFiles.includes(file)) {
      this.state.touchedFiles.push(file);
      this.save();
    }
  }

  public enqueueFiles(files: string[]): void {
    for (const f of files) {
      if (!this.state.pendingQueue.includes(f)) {
        this.state.pendingQueue.push(f);
      }
    }
    this.save();
  }

  public popNextFile(): string | undefined {
    const next = this.state.pendingQueue.shift();
    this.save();
    return next;
  }

  public setLastError(error: string | null): void {
    this.state.lastError = error;
    this.save();
  }

  public incrementStep(): number {
    this.state.stepCount++;
    this.save();
    return this.state.stepCount;
  }

  /**
   * Generates a compact ~150-token representation of external memory
   * to inject into the 8k turn without history bloat.
   */
  public toContextMemoryString(): string {
    const invText = this.state.contractInvariants.length > 0 
      ? `Invariants:\n- ${this.state.contractInvariants.join("\n- ")}` 
      : "Invariants: None established yet.";

    const queueText = this.state.pendingQueue.length > 0
      ? `Pending files: [${this.state.pendingQueue.slice(0, 5).join(", ")}]`
      : "Pending files: None.";

    const errText = this.state.lastError
      ? `Last Diagnostic Error: ${this.state.lastError}`
      : "Last Diagnostic: Clean.";

    return [
      `GOAL: ${this.state.goal}`,
      `STEP: ${this.state.stepCount}`,
      invText,
      queueText,
      errText,
    ].join("\n");
  }
}
