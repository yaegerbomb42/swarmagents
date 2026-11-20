import { MiniOrchestrator } from "./orchestrator.js";
import { AstSlicer } from "./astSlicer.js";
import { LogCondenser } from "./logCondenser.js";
import { ContextGovernor } from "./contextGovernor.js";
import * as fs from "fs";
import * as path from "path";

interface GauntletResult {
  tier: string;
  name: string;
  passed: boolean;
  durationMs: number;
  tokensUsed: number;
  notes: string;
}

const results: GauntletResult[] = [];
const orchestrator = new MiniOrchestrator();
const testDir = "/Users/dev/swarmagents/packages/claude-code-mini/.gauntlet_scratch";

if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

console.log("===============================================================");
console.log("      CLAUDE CODE MINI: THE 4-TIER BATTLE GAUNTLET             ");
console.log("===============================================================\n");

async function runTier1() {
  console.log("[TIER 1] Complex Multi-Line Async/TypeScript Type Repair...");
  const filePath = path.join(testDir, "tier1_async_bug.ts");

  fs.writeFileSync(
    filePath,
    `export interface UserProfile {
  id: string;
  email: string;
  loginCount: number;
}

export class UserManager {
  private cache: Map<string, UserProfile> = new Map();

  public async fetchRemoteUser(id: string): Promise<UserProfile> {
    return { id, email: \`\${id}@example.com\`, loginCount: 1 };
  }

  // BUG 1: Missing await on fetchRemoteUser
  // BUG 2: Incorrect property access (user.count instead of user.loginCount)
  public async getUser(id: string): Promise<UserProfile> {
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }
    const user = this.fetchRemoteUser(id);
    const updated: UserProfile = {
      id: user.id,
      email: user.email,
      loginCount: user.count + 1,
    };
    this.cache.set(id, updated);
    return updated;
  }
}`
  );

  const diagnostic = `Type error in getUser:
1. Missing 'await' on this.fetchRemoteUser(id)
2. Property 'count' does not exist on type 'UserProfile', use 'loginCount'`;

  const t0 = Date.now();
  orchestrator.getState().reset("Fix the missing await and property mismatch in UserManager.getUser");
  const res = await orchestrator.executeFileRepairTurn(filePath, diagnostic, 15, 32);
  const dur = Date.now() - t0;

  const patched = fs.readFileSync(filePath, "utf-8");
  const passed = res.success && patched.includes("await this.fetchRemoteUser") && patched.includes("loginCount + 1");

  results.push({
    tier: "Tier 1",
    name: "Async/Type Bug Repair",
    passed,
    durationMs: dur,
    tokensUsed: res.tokensUsed,
    notes: passed ? "Correctly added await and fixed property name." : `Patch failed: ${res.message}`,
  });
  console.log(`  -> Passed: ${passed} in ${dur}ms (Tokens: ${res.tokensUsed})\n`);
}

async function runTier2() {
  console.log("[TIER 2] 20,000-Token Log Compression Test...");
  const condenser = new LogCondenser((orchestrator as any).client);

  let hugeLog = "Jest Test Suite Runner v29.5.0\n";
  for (let i = 0; i < 250; i++) {
    hugeLog += `  at processTicksAndRejections (node:internal/process/task_queues.js:${i}:12)\n`;
    hugeLog += `  at async Promise.all (index ${i})\n`;
    hugeLog += `  at Object.<anonymous> (/var/app/node_modules/jest-runner/build/runTest.js:${i * 2}:14)\n`;
  }
  hugeLog += "\nCRITICAL FAILURE:\n";
  hugeLog += "FAIL src/auth/jwt.test.ts > TokenVerification > should reject expired bearer tokens\n";
  hugeLog += "Error: Expected status code 401 Unauthorized, but received 200 OK at line 48 in src/auth/jwt.test.ts\n";
  hugeLog += "    Expected: 401\n    Received: 200\n";
  for (let i = 0; i < 200; i++) {
    hugeLog += `  at ModuleLoader.resolve (node:internal/modules/esm/resolve.js:${i}:9)\n`;
  }

  const rawTokens = ContextGovernor.estimateTokens(hugeLog);
  console.log(`  Input Log Size: ${hugeLog.length} chars (~${rawTokens} tokens).`);

  const t0 = Date.now();
  const condensed = await condenser.condenseLog(hugeLog);
  const dur = Date.now() - t0;
  const condensedTokens = ContextGovernor.estimateTokens(condensed);

  const preservedFailure = condensed.includes("401") && condensed.includes("jwt.test.ts");
  const passed = preservedFailure && condensedTokens < 350;

  results.push({
    tier: "Tier 2",
    name: "20k Log Compression",
    passed,
    durationMs: dur,
    tokensUsed: condensedTokens,
    notes: `Compressed ${rawTokens}t -> ${condensedTokens}t (${Math.round((1 - condensedTokens / rawTokens) * 100)}% reduction). Preserved root cause: ${preservedFailure}.`,
  });
  console.log(`  -> Passed: ${passed} in ${dur}ms (Condensed to ${condensedTokens} tokens)\n`);
}

async function runTier3() {
  console.log("[TIER 3] Autonomic Compiler Loop (Self-Correcting Repair)...");
  const filePath = path.join(testDir, "tier3_math.ts");

  fs.writeFileSync(
    filePath,
    `export function divideNumbers(a: number, b: number): number {\n  if (b === 0) return "undefined" as any;\n  return a / b;\n}\n`
  );

  const diagnostic = "Requirement: divideNumbers must throw an Error('Division by zero') when b === 0, not return 'undefined'.";

  const t0 = Date.now();
  orchestrator.getState().reset("Fix divideNumbers to throw Error on division by zero");
  const res = await orchestrator.executeFileRepairTurn(filePath, diagnostic, 1, 6);
  const dur = Date.now() - t0;

  const patched = fs.readFileSync(filePath, "utf-8");
  const passed = res.success && (patched.includes("throw new Error") || patched.includes("throw Error"));

  results.push({
    tier: "Tier 3",
    name: "Autonomic Logic Repair",
    passed,
    durationMs: dur,
    tokensUsed: res.tokensUsed,
    notes: passed ? "Correctly converted invalid return to throw Error." : `Failed: ${res.message}`,
  });
  console.log(`  -> Passed: ${passed} in ${dur}ms (Tokens: ${res.tokensUsed})\n`);
}

async function runTier4() {
  console.log("[TIER 4] Sequential Multi-File Contract Propagation (2 Files without Joint Memory)...");
  const typesPath = path.join(testDir, "tier4_types.ts");
  const consumerPath = path.join(testDir, "tier4_consumer.ts");

  fs.writeFileSync(
    typesPath,
    `export interface AuthSession {\n  sessionId: string;\n  userId: string;\n  expiresAt: number;\n}\n`
  );

  fs.writeFileSync(
    consumerPath,
    `import { AuthSession } from "./tier4_types.js";\n\nexport function printSession(session: AuthSession): string {\n  return \`User: \${session.userId} (\${session.sessionId})\`;\n}\n`
  );

  orchestrator.getState().reset("Refactor userId to accountUuid across types and consumer");
  const t0 = Date.now();

  const step1 = await orchestrator.executeFileRepairTurn(
    typesPath,
    "Rename property 'userId' to 'accountUuid: string' and note invariant",
    1,
    7
  );

  const invariant = orchestrator.getState().toContextMemoryString();
  const step2 = await orchestrator.executeFileRepairTurn(
    consumerPath,
    `Contract update: AuthSession.userId was renamed to accountUuid. Update all usages. ${invariant}`,
    1,
    7
  );

  const dur = Date.now() - t0;
  const patchedTypes = fs.readFileSync(typesPath, "utf-8");
  const patchedConsumer = fs.readFileSync(consumerPath, "utf-8");

  const passed =
    step1.success &&
    step2.success &&
    patchedTypes.includes("accountUuid") &&
    patchedConsumer.includes("session.accountUuid");

  results.push({
    tier: "Tier 4",
    name: "Cross-File Contract Propagation",
    passed,
    durationMs: dur,
    tokensUsed: step1.tokensUsed + step2.tokensUsed,
    notes: passed ? "Both files updated sequentially without joint memory." : "Contract drift occurred.",
  });
  console.log(`  -> Passed: ${passed} in ${dur}ms (Total Tokens: ${step1.tokensUsed + step2.tokensUsed})\n`);
}

async function main() {
  try {
    await runTier1();
    await runTier2();
    await runTier3();
    await runTier4();
  } catch (err: any) {
    console.error("Gauntlet execution interrupted:", err);
  } finally {
    console.log("===============================================================");
    console.log("                 GAUNTLET PERFORMANCE REPORT                  ");
    console.log("===============================================================");
    console.table(
      results.map((r) => ({
        Tier: r.tier,
        Challenge: r.name,
        Status: r.passed ? "PASSED" : "FAILED",
        "Latency (ms)": r.durationMs,
        Tokens: r.tokensUsed,
        Notes: r.notes,
      }))
    );

    const allPassed = results.every((r) => r.passed);
    console.log(
      allPassed
        ? "\n🎉 ALL 4 TIERS PASSED! Claude Code Mini operates stably under 8k tokens."
        : "\n⚠️ SOME TIERS FAILED. Review details above to apply architectural fixes."
    );

    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
