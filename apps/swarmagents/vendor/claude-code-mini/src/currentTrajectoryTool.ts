import * as fs from "fs";
import * as path from "path";

export interface TrajectoryStep {
  step: number;
  objective: string;
  status: "pending" | "running" | "completed" | "failed";
  hypothesis: string;
  evidence: string;
  nextAction: string;
}

export class CurrentTrajectoryTool {
  private trajectoryFilePath: string;
  private trajectory: TrajectoryStep[] = [];
  private activeGoal: string = "";

  constructor(workDir: string = process.cwd()) {
    this.trajectoryFilePath = path.join(workDir, ".claude_mini_trajectory.json");
    this.load();
  }

  private load() {
    if (fs.existsSync(this.trajectoryFilePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.trajectoryFilePath, "utf-8"));
        this.activeGoal = data.activeGoal || "";
        this.trajectory = data.trajectory || [];
      } catch {}
    }
  }

  private save() {
    fs.writeFileSync(
      this.trajectoryFilePath,
      JSON.stringify({ activeGoal: this.activeGoal, trajectory: this.trajectory }, null, 2),
      "utf-8"
    );
  }

  public setGoal(goal: string) {
    this.activeGoal = goal;
    this.trajectory = [];
    this.save();
  }

  public addStep(objective: string, hypothesis: string): TrajectoryStep {
    const step: TrajectoryStep = {
      step: this.trajectory.length + 1,
      objective,
      status: "running",
      hypothesis,
      evidence: "",
      nextAction: "",
    };
    this.trajectory.push(step);
    this.save();
    return step;
  }

  public completeStep(stepNumber: number, evidence: string, nextAction: string = "") {
    const target = this.trajectory.find((s) => s.step === stepNumber);
    if (target) {
      target.status = "completed";
      target.evidence = evidence;
      target.nextAction = nextAction;
      this.save();
    }
  }

  public failStep(stepNumber: number, failureReason: string) {
    const target = this.trajectory.find((s) => s.step === stepNumber);
    if (target) {
      target.status = "failed";
      target.evidence = failureReason;
      this.save();
    }
  }

  /**
   * Formats the trajectory into a tiny ~150-token active plan representation.
   */
  public getTrajectoryPrompt(): string {
    if (this.trajectory.length === 0) {
      return `CURRENT TRAJECTORY: Goal = "${this.activeGoal || "Unset"}". Ready for Step 1.`;
    }

    const lines = this.trajectory.map(
      (s) =>
        `Step ${s.step} [${s.status.toUpperCase()}]: ${s.objective} | Hypothesis: ${s.hypothesis}${
          s.evidence ? " | Evidence: " + s.evidence : ""
        }`
    );

    return `CURRENT TRAJECTORY (Goal: "${this.activeGoal}"):\n` + lines.join("\n");
  }

  public clear(): void {
    this.activeGoal = "";
    this.trajectory = [];
    if (fs.existsSync(this.trajectoryFilePath)) {
      fs.unlinkSync(this.trajectoryFilePath);
    }
  }
}
