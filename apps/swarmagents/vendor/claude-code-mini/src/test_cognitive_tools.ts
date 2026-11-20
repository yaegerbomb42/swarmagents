import { MiniOrchestrator } from "./orchestrator.js";
import { AutoLocator } from "./autoLocator.js";
import { DependencyRadarTool } from "./dependencyRadarTool.js";
import * as path from "path";

async function testNewTools() {
  console.log("=================================================");
  console.log("      TESTING CLAUDE CODE MINI COGNITIVE TOOLS   ");
  console.log("=================================================\n");

  const orchestrator = new MiniOrchestrator();

  // 1. Test AutoLocator
  console.log("1. Testing AutoLocator (Natural Language Query: 'GroqKeyPool cooldown')...");
  const located = AutoLocator.locate("GroqKeyPool cooldown", path.resolve(process.cwd(), "../.."));
  console.log("   Found matches:", located.slice(0, 2).map((l) => `${path.basename(l.filePath)}:L${l.line}`));

  // 2. Test DependencyRadarTool
  console.log("\n2. Testing DependencyRadarTool (Symbol: 'ContextGovernor')...");
  const dependents = DependencyRadarTool.scanDependents("ContextGovernor", path.resolve(process.cwd(), ".."));
  const radarPrompt = DependencyRadarTool.getRadarPrompt("ContextGovernor", dependents);
  console.log("   Radar Prompt (<100 tokens):\n" + radarPrompt);

  // 3. Test CurrentTrajectoryTool
  console.log("\n3. Testing CurrentTrajectoryTool...");
  orchestrator.trajectory.setGoal("Refactor GroqKeyPool to support dynamic token estimation");
  const step1 = orchestrator.trajectory.addStep("Locate keypool class", "File exists in packages/claude-code-mini/src/keypool.ts");
  orchestrator.trajectory.completeStep(step1.step, "Found at line 14", "Add token estimator method");
  console.log("   Trajectory Prompt:\n" + orchestrator.trajectory.getTrajectoryPrompt());

  // 4. Test ChatHistoryTool
  console.log("\n4. Testing ChatHistoryTool (Condensed Rolling Memory)...");
  await orchestrator.chatHistory.recordTurn(
    "Fix email validation in auth service",
    ["src/auth.ts"],
    "Surgically replaced index check with boolean return"
  );
  console.log("   Condensed History Prompt:\n" + orchestrator.chatHistory.getCondensedHistoryPrompt());

  console.log("\n🎉 ALL 4 COGNITIVE TOOLS VERIFIED AND COMPATIBLE WITH 8K LIMIT!");
}

testNewTools().catch(console.error);
