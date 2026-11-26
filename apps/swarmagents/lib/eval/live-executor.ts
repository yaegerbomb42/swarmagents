// Live executor for the multi-provider eval: runs the real Claude Code CLI
// (through the real ClaudeCodeRunner) against a BYOK provider on each task.
//
// The scripted executor proves the suite and the grader work; this one
// answers the product question: does Claude Code on *this* provider and
// model actually finish a general task? Each trial:
//
//   1. runs in the trial's isolated workspace (the runner seeds the setup
//      files and passes the directory in ctx.workspaceDir),
//   2. spawns `claude -p --output-format stream-json` through
//      ClaudeCodeRunner on a local process "VM" (LocalProcessExec), with a
//      throwaway CLAUDE_CONFIG_DIR so the host's own Claude login, history
//      and settings never leak in or out,
//   3. points the CLI at the provider purely through env (buildClaudeEnv);
//      the key is read from a named environment variable, never a literal,
//      and the runner's redactor scrubs it from every event,
//   4. is killed (whole process group) at the per-trial timeout,
//   5. records turns, tokens, wall time and why the run ended.
//
// The runner then lays down the verifier and grades the workspace.
//
// Safety: the agent gets shell access inside the temp workspace on this
// machine (there is no VM in this mode). Run live evals in a container or a
// throwaway box, never on a machine with credentials you care about.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeRunner } from "../harness/runner";
import type { TelemetryEvent, VmExec, VmExecOpts } from "../harness/types";
import { buildClaudeEnv } from "../providers/claude-env";
import type { ProviderKind } from "../providers/types";
import type {
  ProviderEvalTask,
  ProviderExecutor,
  ProviderExecutorResult,
  ProviderRunContext,
  ProviderRunExitReason,
} from "./provider-types";

/** Where the provider comes from: explicit BYOK settings, or a preconfigured wrapper. */
export type LiveProviderConfig =
  | {
      /** Wire the CLI speaks to the provider (Anthropic-compatible gateways use "anthropic"). */
      kind: ProviderKind;
      /** Gateway root; omit for the kind's public host. */
      baseUrl?: string;
      /** Name of the environment variable holding the key. The value is never logged. */
      keyEnv: string;
    }
  | {
      /** The claude binary is a wrapper that sets its own provider env. */
      kind: "preconfigured";
    };

export interface LiveExecutorOptions {
  provider: LiveProviderConfig;
  /** Claude Code binary (or a wrapper script). Default: $CLAUDE_BIN or "claude". */
  claudeBin?: string;
  /** --max-turns per trial. Default 30. */
  maxTurns?: number;
  /** Per-trial wall-clock limit. Default 10 minutes. */
  timeoutMs?: number;
  /** When set, each trial's redacted telemetry is written here as JSONL. */
  logDir?: string;
  /** Environment to read the key from (tests). Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Host env vars the agent process may inherit; everything else is dropped. HOME is replaced by the workspace. */
const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ", "NODE_OPTIONS"] as const;

/** Tools the headless agent may use without an approval prompt. */
const ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "TodoWrite", "NotebookEdit"];

const KILL_GRACE_MS = 2_000;

/**
 * A VmExec backed by a local child process in its own process group. Abort
 * (timeout, cancel) sends SIGTERM to the whole group, then SIGKILL after a
 * short grace, so tools the agent started (servers, sleeps) die with it.
 */
export class LocalProcessExec implements VmExec {
  async exec(cmd: string[], opts: VmExecOpts = {}): Promise<{ exitCode: number }> {
    const [bin, ...args] = cmd;
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        resolve({ exitCode: 130 });
        return;
      }
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        env: (opts.env ?? {}) as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let killTimer: NodeJS.Timeout | undefined;
      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Already gone.
        }
      };
      const onAbort = () => {
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => opts.onStdout?.(chunk));
      child.stderr.on("data", (chunk: string) => opts.onStderr?.(chunk));
      child.on("error", (err) => {
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code, signal) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (killTimer) clearTimeout(killTimer);
        // Reap anything the agent left running in the group.
        killGroup("SIGKILL");
        resolve({ exitCode: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : -1) });
      });
    });
  }
}

/** Build the agent's env: a minimal host passthrough, an isolated config dir, the provider. */
export function buildLiveEnv(
  options: Pick<LiveExecutorOptions, "provider" | "env">,
  model: string,
  configDir: string,
  workspaceDir?: string,
): { env: Record<string, string>; secrets: string[] } {
  const source = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = source[name];
    if (value) env[name] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  // "~" is the trial workspace: tasks that say ~/Desktop land in the graded
  // directory, and nothing the agent does touches the real home directory.
  if (workspaceDir) env.HOME = workspaceDir;
  env.CI = "1";
  const secrets: string[] = [];
  if (options.provider.kind !== "preconfigured") {
    const key = source[options.provider.keyEnv];
    if (!key) throw new Error(`live eval: environment variable ${options.provider.keyEnv} is not set`);
    secrets.push(key);
    Object.assign(
      env,
      buildClaudeEnv({
        provider: "eval",
        kind: options.provider.kind,
        ...(options.provider.baseUrl ? { baseUrl: options.provider.baseUrl } : {}),
        key,
        model,
      }),
    );
  }
  return { env, secrets };
}

/** Usage/turn accounting folded from the runner's telemetry. */
export function foldLiveTelemetry(events: readonly TelemetryEvent[]): {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  finished?: Extract<TelemetryEvent, { type: "run.finished" }>;
  error?: string;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let usageEvents = 0;
  let finished: Extract<TelemetryEvent, { type: "run.finished" }> | undefined;
  let error: string | undefined;
  let lastUsage = "";
  for (const event of events) {
    if (event.type === "usage") {
      // Claude Code streams one assistant event per content block, each
      // repeating the same message's usage: count a snapshot once.
      const key = `${event.inputTokens}/${event.outputTokens}/${event.cachedTokens ?? 0}`;
      if (key === lastUsage) continue;
      lastUsage = key;
      usageEvents += 1;
      inputTokens += event.inputTokens + (event.cachedTokens ?? 0);
      outputTokens += event.outputTokens;
    } else if (event.type === "run.finished") {
      finished = event;
    } else if (event.type === "run.error") {
      error = event.message;
    }
  }
  const turns = finished?.numTurns ?? usageEvents;
  return { turns, inputTokens, outputTokens, ...(finished ? { finished } : {}), ...(error ? { error } : {}) };
}

/** The CLI's own final `result` line: cumulative usage, turn count and how it ended. */
export interface CliResultSummary {
  subtype?: string;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Watches the raw stream-json for the final `result` line. Per-message usage
 * on assistant events is a streaming snapshot (output tokens are often 0 or
 * 1 there); the result line carries the run's real cumulative totals.
 */
export function createResultTap(): { push(chunk: string): void; result(): CliResultSummary | undefined } {
  let buffer = "";
  let summary: CliResultSummary | undefined;
  const consume = (line: string) => {
    if (!line.includes('"result"')) return;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (raw.type !== "result") return;
      const usage = (raw.usage ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const hasUsage = typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number";
      summary = {
        ...(typeof raw.subtype === "string" ? { subtype: raw.subtype } : {}),
        ...(typeof raw.num_turns === "number" ? { numTurns: raw.num_turns } : {}),
        ...(hasUsage
          ? {
              inputTokens:
                n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens),
              outputTokens: n(usage.output_tokens),
            }
          : {}),
      };
    } catch {
      // Not JSON: ignore.
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      if (buffer.length > 4 * 1024 * 1024) buffer = "";
    },
    result() {
      if (buffer.trim()) {
        consume(buffer);
        buffer = "";
      }
      return summary;
    },
  };
}

/** A VmExec that also feeds every stdout chunk to a tap. */
class TappedExec implements VmExec {
  constructor(
    private readonly inner: VmExec,
    private readonly tap: (chunk: string) => void,
  ) {}
  exec(cmd: string[], opts: VmExecOpts = {}) {
    return this.inner.exec(cmd, {
      ...opts,
      onStdout: (chunk) => {
        this.tap(chunk);
        opts.onStdout?.(chunk);
      },
    });
  }
}

export function liveTaskPrompt(task: ProviderEvalTask, workspaceDir: string): string {
  return [
    task.prompt,
    "",
    `Work only in the current directory (${workspaceDir}). Make the changes directly in the files; ` +
      "do not ask questions. When you are done, reply with one sentence saying what you changed.",
  ].join("\n");
}

export class LiveProviderExecutor implements ProviderExecutor {
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly bin: string;

  constructor(private readonly options: LiveExecutorOptions) {
    this.maxTurns = options.maxTurns ?? 30;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.bin = options.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
  }

  async run(task: ProviderEvalTask, ctx: ProviderRunContext): Promise<ProviderExecutorResult> {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) throw new Error("LiveProviderExecutor needs ctx.workspaceDir (run it through ProviderEvalRunner)");
    const configDir = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-claude-config-"));
    const started = Date.now();
    const events: TelemetryEvent[] = [];
    const logFile = this.options.logDir
      ? path.join(this.options.logDir, `${task.id}.${ctx.providerId}.t${ctx.trial ?? 1}.jsonl`.replace(/[^\w.-]/g, "_"))
      : undefined;
    let timedOut = false;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    timer.unref();

    try {
      // Headless permissions: the agent may use the core tools without an
      // approval prompt, inside its throwaway config dir.
      await writeFile(
        path.join(configDir, "settings.json"),
        JSON.stringify({ permissions: { allow: ALLOWED_TOOLS, defaultMode: "acceptEdits" } }, null, 2),
      );
      const { env, secrets } = buildLiveEnv(this.options, ctx.model, configDir, workspaceDir);
      if (logFile) await mkdir(path.dirname(logFile), { recursive: true });

      let exitCode = -1;
      let spawnError: string | undefined;
      const tap = createResultTap();
      try {
        const outcome = await new ClaudeCodeRunner({ bin: this.bin }).run(
          {
            prompt: liveTaskPrompt(task, workspaceDir),
            ...(this.options.provider.kind === "preconfigured" ? {} : { model: ctx.model }),
            maxTurns: this.maxTurns,
            env,
            redactSecrets: secrets,
            vm: new TappedExec(new LocalProcessExec(), (chunk) => tap.push(chunk)),
            cwd: workspaceDir,
            signal: abort.signal,
          },
          (event) => {
            events.push(event);
            if (logFile) void appendFile(logFile, `${JSON.stringify(event)}\n`).catch(() => undefined);
          },
        );
        exitCode = outcome.exitCode;
      } catch (err) {
        spawnError = err instanceof Error ? err.message : String(err);
      }

      const folded = foldLiveTelemetry(events);
      const cli = tap.result();
      const hitMaxTurns = folded.finished?.reason === "max_turns" || cli?.subtype === "error_max_turns";
      const exitReason: ProviderRunExitReason = timedOut
        ? "timeout"
        : spawnError
          ? "error"
          : hitMaxTurns
            ? "max_turns"
            : folded.finished && exitCode === 0
              ? "completed"
              : "error";
      const detail = spawnError ?? (exitReason === "error" ? folded.error ?? `claude exited with code ${exitCode}` : undefined);
      return {
        // The agent edited the workspace in place: no delta to apply.
        files: {},
        deleted: [],
        // The CLI's result totals win; the per-message fold is the
        // fallback for runs that died before printing a result.
        metrics: {
          totalTurns: cli?.numTurns ?? folded.turns,
          totalInputTokens: cli?.inputTokens ?? folded.inputTokens,
          totalOutputTokens: cli?.outputTokens ?? folded.outputTokens,
          wallClockMs: Date.now() - started,
        },
        exitReason,
        ...(detail ? { exitDetail: redactAll(detail, this.knownSecrets()).slice(0, 300) } : {}),
      };
    } finally {
      clearTimeout(timer);
      await rm(configDir, { recursive: true, force: true });
    }
  }

  private knownSecrets(): string[] {
    const provider = this.options.provider;
    if (provider.kind === "preconfigured") return [];
    const key = (this.options.env ?? process.env)[provider.keyEnv];
    return key ? [key] : [];
  }
}

function redactAll(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[REDACTED]");
  return out;
}
