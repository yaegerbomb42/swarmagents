import { MultiProviderKeyPool } from "./multiProviderKeyPool.js";
import { AstSlicer } from "./astSlicer.js";
import { ContextGovernor } from "./contextGovernor.js";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// 1. Define Candidate Models & Keys
const CODESTRAL_KEYS = [
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY",
  "REDACTED_MISTRAL_KEY"
];

const NEMOTRON_KEYS = [
  "nvapi-REDACTED",
  "nvapi-REDACTED",
  "nvapi-REDACTED",
  "nvapi-REDACTED",
  "nvapi-REDACTED",
  "nvapi-REDACTED",
  "nvapi-REDACTED",
  "nvapi-REDACTED",
  "nvapi-REDACTED"
];

// Target Test Challenge: A realistic production rate-limiter with token leak bug
const CHALLENGE_SOURCE = `export interface RateLimitConfig {
  capacity: number;
  refillRatePerSec: number;
}

export class TokenBucketLimiter {
  private tokens: number;
  private lastRefillTimestamp: number;
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.tokens = config.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  // BUG 1: Refill calculation divides by 10000 instead of 1000 (leaking tokens 10x too slow)
  // BUG 2: Math.min omitted on tokens refill, allowing tokens to exceed capacity indefinitely
  public consume(tokensRequested: number = 1): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillTimestamp) / 10000;
    this.tokens = this.tokens + (elapsedSec * this.config.refillRatePerSec);
    this.lastRefillTimestamp = now;

    if (this.tokens >= tokensRequested) {
      this.tokens -= tokensRequested;
      return true;
    }
    return false;
  }

  public getAvailableTokens(): number {
    return this.tokens;
  }
}
`;

const DIAGNOSTIC_ERROR = `Failures detected in TokenBucketLimiter:
1. 'elapsedSec' calculation incorrectly divides by 10000 instead of 1000 ms.
2. Tokens accumulator fails to cap at config.capacity: use Math.min(this.config.capacity, ...)
Ensure tokens are strictly capped at capacity on every refill.`;

async function executeBenchmarkTurn(
  pool: MultiProviderKeyPool,
  modelName: string,
  mode: "Claude-Code-Mini (8k Stateless)" | "Claude-Code (Full Context Proxy)"
) {
  const uniqueId = Math.random().toString(36).substring(2, 8);
  const scratchFile = `/tmp/bench_${modelName.replace(/[^a-zA-Z0-9]/g, "_")}_${uniqueId}.ts`;
  fs.writeFileSync(scratchFile, CHALLENGE_SOURCE, "utf-8");

  const t0 = Date.now();

  let systemPrompt = "";
  let userPayload = "";

  if (mode === "Claude-Code-Mini (8k Stateless)") {
    // 8k Stateless format: Micro prompt + slice only (<1,000 tokens)
    const slice = AstSlicer.readSlice(scratchFile, 15, 35);
    systemPrompt = "You are Claude Code Mini. Stateless 8k code patcher. Output search and replace JSON.";
    userPayload = [
      `FILE: ${scratchFile}`,
      `DIAGNOSTIC: ${DIAGNOSTIC_ERROR}`,
      `SLICE:`,
      slice.content,
      `Respond in strict JSON: {"search": "exact code", "replace": "fixed code"}`,
    ].join("\n");
  } else {
    // Full Context Format (Classic Claude Code): Dumps whole file and broad conversation instructions
    systemPrompt = "You are Claude Code, an expert autonomous software engineer. Review the file and provide a fix for the reported diagnostic.";
    userPayload = [
      `Here is the entire file content:`,
      CHALLENGE_SOURCE,
      ``,
      `Diagnostic error reports:`,
      DIAGNOSTIC_ERROR,
      `Provide the exact SEARCH and REPLACE block to resolve this issue in JSON format: {"search": "...", "replace": "..."}`,
    ].join("\n");
  }

  const completion = await pool.chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPayload },
    ],
    { temperature: 0.1, response_format: { type: "json_object" } }
  );

  const durationMs = Date.now() - t0;
  let correct = false;
  let patchApplied = false;

  try {
    let cleanJson = completion.content.trim();
    const match = cleanJson.match(/\{[\s\S]*\}/);
    if (match) cleanJson = match[0];
    const parsed = JSON.parse(cleanJson);
    if (parsed.search && parsed.replace) {
      AstSlicer.applySlicePatch(scratchFile, parsed.search, parsed.replace);
      patchApplied = true;
    }
  } catch (err: any) {
    console.warn(`[${modelName}] Parse failed:`, err.message);
  }

  const finalContent = fs.readFileSync(scratchFile, "utf-8");
  const hasDiv1000 = finalContent.includes("/ 1000") && !finalContent.includes("/ 10000");
  const hasCap = finalContent.includes("Math.min") && finalContent.includes("capacity");

  correct = patchApplied && hasDiv1000 && hasCap;

  fs.unlinkSync(scratchFile);

  const totalTokens = completion.usage?.total_tokens || ContextGovernor.estimateTokens(userPayload + completion.content);
  const promptTokens = completion.usage?.prompt_tokens || ContextGovernor.estimateTokens(userPayload);
  const completionTokens = completion.usage?.completion_tokens || ContextGovernor.estimateTokens(completion.content);

  return {
    model: modelName,
    mode,
    correct,
    durationMs,
    totalTokens,
    promptTokens,
    completionTokens,
  };
}

async function runFullHeadToHead() {
  console.log("==========================================================================");
  console.log("       HEAD-TO-HEAD BENCHMARK: CLAUDE CODE MINI vs CLAUDE CODE            ");
  console.log("   Powered by Codestral (Mistral) & Nemotron 550B (NVIDIA NIM)            ");
  console.log("==========================================================================\n");

  const codestralPool = new MultiProviderKeyPool({
    providerName: "Mistral Codestral",
    baseUrl: "https://codestral.mistral.ai/v1",
    model: "codestral-latest",
    keys: CODESTRAL_KEYS,
  });

  const nemotronPool = new MultiProviderKeyPool({
    providerName: "NVIDIA Nemotron 550B",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    keys: NEMOTRON_KEYS,
  });

  console.log("Running Codestral benchmarks in parallel...");
  const [miniCodestral, classicCodestral] = await Promise.all([
    executeBenchmarkTurn(codestralPool, "codestral-latest", "Claude-Code-Mini (8k Stateless)"),
    executeBenchmarkTurn(codestralPool, "codestral-latest", "Claude-Code (Full Context Proxy)"),
  ]);

  console.log("Running Nemotron 550B benchmarks in parallel...");
  const [miniNemotron, classicNemotron] = await Promise.all([
    executeBenchmarkTurn(nemotronPool, "nemotron-550b", "Claude-Code-Mini (8k Stateless)"),
    executeBenchmarkTurn(nemotronPool, "nemotron-550b", "Claude-Code (Full Context Proxy)"),
  ]);

  const benchmarkTable = [miniCodestral, classicCodestral, miniNemotron, classicNemotron];

  console.log("\n==========================================================================");
  console.log("                         BENCHMARK RESULTS MATRIX                         ");
  console.log("==========================================================================");
  console.table(
    benchmarkTable.map((b) => ({
      Model: b.model,
      Architecture: b.mode,
      Correctness: b.correct ? "✅ PASSED" : "❌ FAILED",
      "Latency (ms)": b.durationMs,
      "Total Tokens": b.totalTokens,
      "Prompt Tokens": b.promptTokens,
      "Output Tokens": b.completionTokens,
    }))
  );
}

runFullHeadToHead().catch(console.error);
