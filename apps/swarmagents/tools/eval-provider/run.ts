// Multi-provider real-task desktop eval CLI.
//
// Scripted (CI-safe, deterministic):
//   tsx tools/eval-provider/run.ts --providers anthropic,openai --out eval-out
//   tsx tools/eval-provider/run.ts --providers anthropic --trials 3 --vm fake
//
// Live (the real Claude Code CLI on a BYOK provider; see lib/eval/README.md):
//   npm run eval:live -- --base-url https://gateway.example/v1 --model my-model \
//     --key-env MY_PROVIDER_KEY --trials 1
//   npm run eval:live -- --claude-bin ./my-claude-wrapper --model my-model
//
// The key is read from the named environment variable and never printed.
// Exit 0 = wrote the report; 2 = usage error.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalTempIsolation,
  PROVIDER_EVAL_TASKS,
  ProviderEvalRunner,
  renderProviderMarkdownTable,
  writeProviderReport,
  type ProviderSpec,
} from "../../lib/eval/index";
import { LiveProviderExecutor, type LiveProviderConfig } from "../../lib/eval/live-executor";
import type { ProviderKind } from "../../lib/providers/types";
import { FakeVmDriver } from "../../lib/vm/fake-driver";

export interface LiveCliOptions {
  provider: LiveProviderConfig;
  model: string;
  claudeBin?: string;
  maxTurns: number;
  timeoutS: number;
}

export interface CliOptions {
  providers: ProviderSpec[];
  trials: number;
  outDir: string;
  vm: "none" | "fake" | "docker";
  /** Only these task ids (default: all). */
  tasks?: string[];
  live?: LiveCliOptions;
}

const USAGE =
  "Usage: tsx tools/eval-provider/run.ts [--providers a,b] [--trials N] [--out DIR] [--vm none|fake|docker] [--tasks id,id|hard|standard]\n" +
  "  live: --live --model M (--key-env VAR [--base-url URL] [--kind anthropic|openai|gemini] | --claude-bin WRAPPER)\n" +
  "        [--provider-id LABEL] [--max-turns N] [--timeout-s S]";

const KINDS: readonly ProviderKind[] = ["anthropic", "openai", "gemini"];

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    providers: [],
    trials: 1,
    outDir: "provider-eval-out",
    vm: "fake",
  };
  let live = false;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let keyEnv: string | undefined;
  let kind: ProviderKind = "anthropic";
  let claudeBin: string | undefined;
  let providerId: string | undefined;
  let maxTurns = 30;
  let timeoutS = 600;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--providers" && next) {
      opts.providers = next
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => ({ providerId: p, model: "model" }));
    } else if (arg === "--trials" && next) {
      opts.trials = Math.max(1, parseInt(next, 10) || 1);
    } else if (arg === "--out" && next) {
      opts.outDir = next;
    } else if (arg === "--vm" && next) {
      if (next !== "none" && next !== "fake" && next !== "docker") {
        throw new Error("--vm must be one of none | fake | docker");
      }
      opts.vm = next as CliOptions["vm"];
    } else if (arg === "--tasks" && next) {
      opts.tasks = next.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--live") {
      live = true;
      continue;
    } else if (arg === "--base-url" && next) {
      baseUrl = next;
    } else if (arg === "--model" && next) {
      model = next;
    } else if (arg === "--key-env" && next) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next)) throw new Error("--key-env takes an environment variable NAME, not a key");
      keyEnv = next;
    } else if (arg === "--kind" && next) {
      if (!KINDS.includes(next as ProviderKind)) throw new Error("--kind must be one of anthropic | openai | gemini");
      kind = next as ProviderKind;
    } else if (arg === "--claude-bin" && next) {
      claudeBin = next;
    } else if (arg === "--provider-id" && next) {
      providerId = next;
    } else if (arg === "--max-turns" && next) {
      maxTurns = Math.max(1, parseInt(next, 10) || maxTurns);
    } else if (arg === "--timeout-s" && next) {
      timeoutS = Math.max(5, parseInt(next, 10) || timeoutS);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg.startsWith("--") && next && arg !== "--help" && arg !== "-h") i++;
  }

  if (live) {
    if (!model) throw new Error("--live needs --model");
    if (!keyEnv && !claudeBin) throw new Error("--live needs --key-env VAR (or --claude-bin for a preconfigured wrapper)");
    const provider: LiveProviderConfig = keyEnv
      ? { kind, keyEnv, ...(baseUrl ? { baseUrl } : {}) }
      : { kind: "preconfigured" };
    opts.live = { provider, model, maxTurns, timeoutS, ...(claudeBin ? { claudeBin } : {}) };
    opts.vm = "none";
    opts.providers = [{ providerId: providerId ?? hostLabel(baseUrl) ?? (keyEnv ? kind : "wrapper"), model }];
  }
  if (opts.providers.length === 0) {
    opts.providers = [{ providerId: "anthropic", model: "model" }];
  }
  return opts;
}

/** A readable, non-secret provider label from a base URL ("api.example.com"). */
function hostLabel(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  const tasks = opts.tasks ? selectTasks(opts.tasks) : PROVIDER_EVAL_TASKS;
  if (tasks.length === 0) {
    console.error(`--tasks matched nothing. Known: ${PROVIDER_EVAL_TASKS.map((t) => t.id).join(", ")}`);
    return 2;
  }
  const isolationRoot = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-provider-cli-"));
  let vmDriver;
  if (opts.vm === "fake") {
    vmDriver = new FakeVmDriver();
    await vmDriver.ensure("cli");
  } else if (opts.vm === "docker") {
    // DockerVmDriver requires a running desktop image; not available in CI.
    throw new Error("--vm docker is intended for local/manual runs only");
  }
  const executor = opts.live
    ? new LiveProviderExecutor({
        provider: opts.live.provider,
        maxTurns: opts.live.maxTurns,
        timeoutMs: opts.live.timeoutS * 1000,
        logDir: path.join(opts.outDir, "logs"),
        ...(opts.live.claudeBin ? { claudeBin: opts.live.claudeBin } : {}),
      })
    : undefined;
  const runner = new ProviderEvalRunner({
    isolation: new LocalTempIsolation(isolationRoot),
    vmDriver,
    ...(executor ? { executor, mode: "live" as const } : {}),
  });
  try {
    const results = await runner.runSuite(opts.providers, { trialsPerTask: opts.trials, tasks });
    const report = runner.summarize(results);
    const { jsonPath, markdownPath } = await writeProviderReport(opts.outDir, report);
    console.log(renderProviderMarkdownTable(report));
    console.log(`\nWrote ${jsonPath} and ${markdownPath}`);
  } finally {
    await rm(isolationRoot, { recursive: true, force: true });
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(`eval-provider error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    });
}

/** `--tasks` takes task ids and/or the set names "hard" and "standard". */
export function selectTasks(names: string[]): typeof PROVIDER_EVAL_TASKS {
  return PROVIDER_EVAL_TASKS.filter(
    (t) =>
      names.includes(t.id) ||
      (names.includes("hard") && t.difficulty === "hard") ||
      (names.includes("standard") && t.difficulty !== "hard"),
  );
}
