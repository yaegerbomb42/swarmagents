import { MiniOrchestrator } from "./orchestrator.js";
import { AutoLocator } from "./autoLocator.js";
import { AstSlicer } from "./astSlicer.js";
import { AutoRepairLoop } from "./autoRepairLoop.js";
import { ParallelSwarmWorker } from "./parallelSwarmWorker.js";
import { AutoTestGenerator } from "./autoTestGenerator.js";
import { GitSmartCommitter } from "./gitSmartCommitter.js";
import { DependencyRadarTool } from "./dependencyRadarTool.js";
import { QuickConnectTool, SUPPORTED_PROVIDERS } from "./quickConnect.js";
import * as readline from "readline";
import * as path from "path";

export class ClaudeMiniREPL {
  private orchestrator: MiniOrchestrator;
  private autoLoop: AutoRepairLoop;
  private swarm: ParallelSwarmWorker;
  private testGen: AutoTestGenerator;
  private committer: GitSmartCommitter;
  private quickConnect: QuickConnectTool;
  private rl: readline.Interface;

  constructor(workDir: string = process.cwd()) {
    this.orchestrator = new MiniOrchestrator(workDir);
    this.autoLoop = new AutoRepairLoop(this.orchestrator);
    this.swarm = new ParallelSwarmWorker(this.orchestrator);
    this.testGen = new AutoTestGenerator(this.orchestrator.client);
    this.committer = new GitSmartCommitter(this.orchestrator.client);
    this.quickConnect = new QuickConnectTool();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[36mclaude-code-mini > \x1b[0m",
    });
  }

  public async start() {
    const pool = this.orchestrator.client.getPool();
    console.log("===================================================================");
    console.log("                     CLAUDE CODE MINI REPL (v0.3.0)                ");
    console.log("      Autonomous 8k Coding Assistant | Free & Sub-Cent Compute     ");
    console.log("      Commands:                                                    ");
    console.log("        connect         -> Quick 1-click connect Groq/Mistral/NVIDIA");
    console.log("        commit          -> Auto-generate conventional git commit   ");
    console.log("        test <cmd>      -> Run verification test & auto-repair     ");
    console.log("        radar <sym>     -> Check cross-file downstream references  ");
    console.log("        history         -> View rolling condensed session memory   ");
    console.log("        exit / quit     -> Leave REPL                              ");
    console.log("===================================================================\n");

    this.rl.prompt();

    this.rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) {
        this.rl.prompt();
        return;
      }

      if (input === "exit" || input === "quit") {
        console.log("Goodbye!");
        process.exit(0);
      }

      try {
        await this.handleInput(input);
      } catch (err: any) {
        console.error(`\x1b[31m[Error] ${err.message}\x1b[0m`);
      }

      console.log("");
      this.rl.prompt();
    });
  }

  private async handleInput(input: string) {
    const t0 = Date.now();

    // 0. Connect Command (/connect or connect)
    if (input === "/connect" || input === "connect" || input.startsWith("/connect ") || input.startsWith("connect ")) {
      const parts = input.split(/\s+/);
      if (parts.length >= 3) {
        const prov = parts[1].toLowerCase();
        const key = parts[2];
        if (SUPPORTED_PROVIDERS[prov]) {
          this.quickConnect.saveKey(prov, key);
          console.log(`\x1b[32m✔ Saved key for ${SUPPORTED_PROVIDERS[prov].name} to ~/.config/claude-code-mini/providers.json\x1b[0m`);
          return;
        }
      }

      console.log("\n\x1b[35m=== CLAUDE CODE MINI: 1-CLICK QUICK CONNECT ===\x1b[0m");
      console.log("Supported providers:");
      console.log("  [1] Groq (Free, ultra-fast 300+ tok/s)");
      console.log("  [2] Mistral (Codestral code specialist)");
      console.log("  [3] NVIDIA NIM (Nemotron 550B free credits)");
      console.log("  [4] OpenRouter (Universal endpoint)\n");

      console.log("Quick Links (cmd + click to open):");
      for (const [id, prov] of Object.entries(SUPPORTED_PROVIDERS)) {
        console.log(`  * ${prov.name}: \x1b[4m${prov.consoleUrl}\x1b[0m`);
      }
      console.log("\nUsage:");
      console.log("  /connect <groq|mistral|nvidia|openrouter> <your_api_key>");
      return;
    }

    // 1. Git Commit Command
    if (input === "commit" || input.startsWith("commit ")) {
      console.log("\x1b[33m[GitSmartCommitter] Analyzing diff & generating conventional commit...\x1b[0m");
      const res = await this.committer.smartCommit(true);
      if (res.success) {
        console.log(`\x1b[32m✔ Committed: "${res.commitMessage}"\x1b[0m`);
      } else {
        console.log(`\x1b[31m✘ ${res.output}\x1b[0m`);
      }
      return;
    }

    // 2. Radar Command
    if (input.startsWith("radar ")) {
      const sym = input.slice(6).trim();
      const deps = DependencyRadarTool.scanDependents(sym);
      console.log("\n" + DependencyRadarTool.getRadarPrompt(sym, deps));
      return;
    }

    // 3. History Command
    if (input === "history") {
      console.log("\n" + this.orchestrator.chatHistory.getCondensedHistoryPrompt());
      console.log(this.orchestrator.trajectory.getTrajectoryPrompt());
      return;
    }

    // 4. Test & Auto-Repair Loop Command
    if (input.startsWith("test ") || input.startsWith("check ")) {
      const cmd = input.replace(/^(test|check)\s+/, "").trim();
      console.log(`\x1b[33m[AutoRepairWatcher] Running check: "${cmd}"...\x1b[0m`);
      const check = await this.orchestrator.runCommand(cmd);

      if (check.success) {
        console.log(`\x1b[32m✔ All checks passed cleanly with exit code 0!\x1b[0m`);
        return;
      }

      console.log(`\x1b[31m✘ Check failed. Locating target file...\x1b[0m`);
      const targets = AutoLocator.locate(check.output);
      if (targets.length === 0) {
        console.log(`Could not automatically locate file from error. Output:\n${check.output}`);
        return;
      }

      const targetFile = targets[0].filePath;
      console.log(`Target identified: ${targetFile}. Initiating autonomous repair loop...`);
      const loopRes = await this.autoLoop.autoRepairUntilPassing(targetFile, cmd, Math.max(1, targets[0].line - 15), targets[0].line + 35);
      console.log(`Loop finished in ${Date.now() - t0}ms. Success: ${loopRes.success}`);
      return;
    }

    // 5. Natural Language Task (Default: Auto-Locate + Surgical Patch)
    console.log(`\x1b[33m[AutoLocator] Scanning repository for task relevance...\x1b[0m`);
    const targets = AutoLocator.locate(input);

    if (targets.length === 0) {
      console.log(`\x1b[33mCould not find exact file automatically. Running as shell query or outline...\x1b[0m`);
      const cmdRes = await this.orchestrator.runCommand(input);
      console.log(cmdRes.output);
      return;
    }

    const primaryTarget = targets[0];
    console.log(`Found target file: \x1b[32m${primaryTarget.filePath}\x1b[0m (line ~${primaryTarget.line})`);
    console.log(`Executing atomic 8k repair turn via Groq keypool...`);

    const startLine = Math.max(1, primaryTarget.line - 15);
    const endLine = primaryTarget.line + 35;

    const res = await this.orchestrator.executeFileRepairTurn(primaryTarget.filePath, input, startLine, endLine);
    const dur = Date.now() - t0;

    if (res.success) {
      console.log(`\x1b[32m✔ Applied surgical patch to ${path.basename(primaryTarget.filePath)} in ${dur}ms (Tokens: ${res.tokensUsed})\x1b[0m`);
      await this.orchestrator.chatHistory.recordTurn(input, [primaryTarget.filePath], res.message);
    } else {
      console.log(`\x1b[31m✘ Repair turn failed: ${res.message}\x1b[0m`);
    }
  }
}
