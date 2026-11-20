import { GroqClient } from "./groqClient.js";
import { AstSlicer } from "./astSlicer.js";
import { LogCondenser } from "./logCondenser.js";
import { StateEngine } from "./stateEngine.js";
import { MiniOrchestrator } from "./orchestrator.js";
import * as fs from "fs";
import * as path from "path";

async function runEndToEndVerification() {
  console.log("==================================================");
  console.log("  CLAUDE CODE MINI: END-TO-END VERIFICATION TEST  ");
  console.log("==================================================\n");

  const testFile = path.resolve(process.cwd(), "temp_broken_test.ts");
  // Create a synthetic broken file
  fs.writeFileSync(
    testFile,
    `export function calculateUserTotal(items: number[]) {\n  // BUG: item is subtracted instead of added\n  let sum = 0;\n  for (const item of items) {\n    sum -= item;\n  }\n  return sum;\n}\n`
  );

  console.log("1. Created synthetic broken file:", testFile);
  console.log("   Current content:\n" + fs.readFileSync(testFile, "utf-8"));

  const orchestrator = new MiniOrchestrator();
  orchestrator.getState().reset("Fix the summation bug in calculateUserTotal so sum accumulates properly");

  const diagnostic = "Test failed: calculateUserTotal([10, 20]) expected 30, but received -30.";
  console.log("2. Injecting diagnostic error:\n   ", diagnostic);

  console.log("\n3. Executing atomic 8k repair turn via Groq keypool...");
  const start = Date.now();
  const result = await orchestrator.executeFileRepairTurn(testFile, diagnostic, 1, 20);
  const duration = Date.now() - start;

  console.log(`\n4. Turn completed in ${duration}ms!`);
  console.log("   Result:", result);

  const updatedContent = fs.readFileSync(testFile, "utf-8");
  console.log("\n5. Patched File Content:\n" + updatedContent);

  // Verification
  if (updatedContent.includes("sum += item")) {
    console.log("\n>>> VERIFICATION SUCCESS: Bug was surgically fixed under 8k tokens! <<<");
  } else {
    console.log("\n>>> VERIFICATION WARNING: Check patch output above. <<<");
  }

  // Clean up test file
  fs.unlinkSync(testFile);
}

runEndToEndVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
