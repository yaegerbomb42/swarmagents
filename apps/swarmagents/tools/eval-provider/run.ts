// Multi-provider real-task desktop eval CLI.
//
// Usage:
//   tsx tools/eval-provider/run.ts --providers anthropic,openai --out eval-out
//   tsx tools/eval-provider/run.ts --providers anthropic --trials 3 --vm fake
//   tsx tools/eval-provider/run.ts --help
//
// The suite runs deterministically (scripted executors) so it is CI-safe.
// `--vm fake` additionally provisions each trial into the in-memory
// FakeVmDriver to exercise the VM path; `--vm docker` is the intended local
// manual mode (a DockerVmDriver, not available in CI). Exit 0 = wrote the
// report; 2 = usage error.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalTempIsolation,
  ProviderEvalRunner,
  renderProviderMarkdownTable,
  writeProviderReport,
  type ProviderSpec,
} from "../../lib/eval/index";
import { FakeVmDriver } from "../../lib/vm/fake-driver";

export interface CliOptions {
  providers: ProviderSpec[];
  trials: number;
  outDir: string;
  vm: "none" | "fake" | "docker";
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    providers: [],
    trials: 1,
    outDir: "provider-eval-out",
    vm: "fake",
  };
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
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx tools/eval-provider/run.ts [--providers a,b] [--trials N] " +
          "[--out DIR] [--vm none|fake|docker]",
      );
      process.exit(0);
    }
    if (arg.startsWith("--") && next && arg !== "--help" && arg !== "-h") i++;
  }
  if (opts.providers.length === 0) {
    opts.providers = [{ providerId: "anthropic", model: "model" }];
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const isolationRoot = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-provider-cli-"));
  let vmDriver;
  if (opts.vm === "fake") {
    vmDriver = new FakeVmDriver();
    await vmDriver.ensure("cli");
  } else if (opts.vm === "docker") {
    // DockerVmDriver requires a running desktop image; not available in CI.
    throw new Error("--vm docker is intended for local/manual runs only");
  }
  const runner = new ProviderEvalRunner({
    isolation: new LocalTempIsolation(isolationRoot),
    vmDriver,
  });
  const results = await runner.runSuite(opts.providers, { trialsPerTask: opts.trials });
  const report = runner.summarize(results);
  const { jsonPath, markdownPath } = await writeProviderReport(opts.outDir, report);
  console.log(renderProviderMarkdownTable(report));
  console.log(`\nWrote ${jsonPath} and ${markdownPath}`);
  await rm(isolationRoot, { recursive: true, force: true });
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
