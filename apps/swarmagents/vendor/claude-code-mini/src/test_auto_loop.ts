import { AutoRepairLoop } from "./autoRepairLoop.js";
import * as fs from "fs";
import * as path from "path";

async function runAutoLoopTest() {
  console.log("=================================================");
  console.log("   TESTING AUTO-REPAIR WATCHER & SAFETY ROLLBACK ");
  console.log("=================================================\n");

  const testFile = path.resolve(process.cwd(), "temp_auto_fix.ts");
  
  // Create broken file with 2 deliberate syntax/logic issues
  fs.writeFileSync(
    testFile,
    `export function validateEmail(email: string): boolean {
  // BUG: uses indexOf instead of regex or includes, and bad return
  if (email.indexOf("@") === -1) {
    return "false" as any;
  }
  return true;
}
`
  );

  const testScript = path.resolve(process.cwd(), "temp_runner.js");
  fs.writeFileSync(
    testScript,
    `const fs = require('fs');
const content = fs.readFileSync('${testFile}', 'utf-8');
if (content.includes('"false" as any')) {
  console.error("FAIL: validateEmail returns string 'false' instead of boolean false");
  process.exit(1);
}
if (!content.includes('return false')) {
  console.error("FAIL: validateEmail does not return false on missing @");
  process.exit(1);
}
console.log("PASS: validateEmail properly returns boolean false");
process.exit(0);
`
  );

  const loop = new AutoRepairLoop();
  const result = await loop.autoRepairUntilPassing(testFile, `node ${testScript}`, 1, 15);

  console.log("\n=== Final Loop Summary ===");
  console.log("Success:", result.success);
  console.log("Iterations needed:", result.iterations);
  console.log("Total tokens used across loop:", result.tokensUsed);
  console.log("Final file content:\n" + fs.readFileSync(testFile, "utf-8"));

  // Clean up
  fs.unlinkSync(testFile);
  fs.unlinkSync(testScript);
}

runAutoLoopTest().catch(console.error);
