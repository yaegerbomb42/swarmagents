// In-memory fake VM driver for tests and environments without Docker.

import { randomBytes } from "node:crypto";
import {
  FAKE_CLAUDE_APPROVAL_TRANSCRIPT_LINES,
  FAKE_CLAUDE_APPROVAL_TRIGGER,
  FAKE_CLAUDE_AUTO_APPROVE_TRANSCRIPT_LINES,
  FAKE_CLAUDE_AUTO_APPROVE_TRIGGER,
  FAKE_CLAUDE_MEMORY_ASSISTANT_TEXT,
  FAKE_CLAUDE_MEMORY_TOOL,
  FAKE_CLAUDE_MEMORY_TOOL_ID,
  FAKE_CLAUDE_HOST_TARGET_TRANSCRIPT_LINES,
  FAKE_CLAUDE_HOST_TARGET_TRIGGER,
  FAKE_CLAUDE_QUESTION_TRANSCRIPT_LINES,
  FAKE_CLAUDE_QUESTION_TRIGGER,
  FAKE_CLAUDE_TRANSCRIPT_LINES,
  memoryFactFromPrompt,
  recalledMemoryAssistantText,
  recalledMemoryFromSystemPrompt,
} from "./fake-claude";
import {
  MEMORY_VM_DIR,
  MEMORY_VM_REQUEST_PREFIX,
  MEMORY_VM_RESPONSE_PREFIX,
} from "../memory/types";
import { questionPaths } from "../harness/ask-mcp";
import type {
  VmDesktopEndpoint,
  VmDriver,
  VmHandle,
  ExecOptions,
  ExecResult,
  VmState,
  VmDirEntry,
  VmFileBytes,
  VmFileStat,
  VmSnapshot,
  RealpathOptions,
} from "./types";
import {
  VmFileError,
  VmPathError,
  WORKSPACE_ROOT,
  assertWorkspaceContainment,
  resolveWorkspacePath,
} from "./files";
import { validateSnapshotLabel } from "./docker-driver";

interface FakeSnapshot {
  info: VmSnapshot;
  files: Map<string, string>;
  links: Map<string, string>;
  mtimes: Map<string, number>;
  running: boolean;
}

interface FakeVm {
  handle: VmHandle;
  files: Map<string, string>;
  /** Simulated symlinks: absolute link path -> target (absolute or relative). */
  links: Map<string, string>;
  mtimes: Map<string, number>;
  running: boolean;
  snapshots: Map<string, FakeSnapshot>;
}

export interface FakeVmDriverOptions {
  /**
   * Replay the recorded stream-json transcript for `claude` invocations.
   * Defaults to true; set SWARM_FAKE_CLAUDE=0 (or pass false) to disable.
   */
  replayClaude?: boolean;
}

function isClaudeCommand(prog: string): boolean {
  const base = prog.replace(/\\/g, "/").split("/").pop();
  return base === "claude";
}

/** Collapse "." / ".." and duplicate slashes in a simulated VM path. */
function normalizeFakePath(input: string): string {
  const parts: string[] = [];
  for (const segment of input.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** The prompt passed to the claude CLI: the argument after `--` (or after `-p` in the legacy form). */
function claudePrompt(cmd: string[]): string {
  const terminator = cmd.indexOf("--");
  if (terminator >= 0) return cmd[terminator + 1] ?? "";
  // Legacy form `claude -p <prompt> ...`.
  const index = cmd.indexOf("-p");
  const next = index >= 0 ? cmd[index + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? next : "";
}

/**
 * Pick the replay transcript for a claude invocation. Specific scenarios win
 * over the benign smoke check: ask_user, then a host-targeted call, then the
 * risky cleanup used by the risk-gate tests.
 */
function transcriptForClaude(cmd: string[]): readonly string[] {
  const prompt = claudePrompt(cmd).toLowerCase();
  if (prompt.includes(FAKE_CLAUDE_QUESTION_TRIGGER)) return FAKE_CLAUDE_QUESTION_TRANSCRIPT_LINES;
  if (prompt.includes(FAKE_CLAUDE_HOST_TARGET_TRIGGER)) return FAKE_CLAUDE_HOST_TARGET_TRANSCRIPT_LINES;
  if (prompt.includes(FAKE_CLAUDE_AUTO_APPROVE_TRIGGER)) return FAKE_CLAUDE_AUTO_APPROVE_TRANSCRIPT_LINES;
  return prompt.includes(FAKE_CLAUDE_APPROVAL_TRIGGER)
    ? FAKE_CLAUDE_APPROVAL_TRANSCRIPT_LINES
    : FAKE_CLAUDE_TRANSCRIPT_LINES;
}

/** The value of the `--append-system-prompt` flag, when the run carries one. */
function systemPromptFor(cmd: string[]): string {
  const index = cmd.indexOf("--append-system-prompt");
  if (index === -1) return "";
  return cmd[index + 1] ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeAsk {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

/** The ask_user tool_use in a transcript line, if there is one. */
function askToolUse(line: string): FakeAsk | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = parsed as { message?: { content?: unknown } };
  const content = Array.isArray(record.message?.content) ? record.message.content : [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;
    if (b.name !== "ask_user" && !b.name.endsWith("__ask_user")) continue;
    const question = typeof b.input?.question === "string" ? b.input.question : "";
    if (!question) continue;
    return {
      question,
      options: Array.isArray(b.input?.options)
        ? b.input.options.filter((option): option is string => typeof option === "string")
        : [],
      allowFreeText: b.input?.allow_free_text !== false,
    };
  }
  return undefined;
}

export class FakeVmDriver implements VmDriver {
  private vms = new Map<string, FakeVm>();
  private readonly replayClaude: boolean;

  constructor(options: FakeVmDriverOptions = {}) {
    this.replayClaude = options.replayClaude ?? process.env.SWARM_FAKE_CLAUDE !== "0";
  }

  private getOrCreateVm(userId: string): FakeVm {
    let vm = this.vms.get(userId);
    if (!vm) {
      vm = {
        handle: { userId, containerName: `fake-${userId}`, createdAt: Date.now() },
        files: new Map(),
        links: new Map(),
        mtimes: new Map(),
        running: true,
        snapshots: new Map(),
      };
      this.vms.set(userId, vm);
    }
    return vm;
  }

  async ensure(userId: string): Promise<VmHandle> {
    const vm = this.getOrCreateVm(userId);
    vm.running = true;
    return vm.handle;
  }

  /**
   * Replay the memory transcript: the fake agent calls the memory MCP tool
   * and the host's answer comes back. The in-VM MCP server is emulated here
   * (the fake VM has no real MCP server), over the very same file RPC the
   * real server uses — so the host bridge and the store are exercised for
   * real.
   */
  private async replayMemoryClaude(
    vm: FakeVm,
    fact: string,
    onStdout: (chunk: string) => void,
  ): Promise<void> {
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: "/workspace",
        session_id: "sess_fake_playtest",
        model: "claude-sonnet-5-5",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_fake_memory_1",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "Noted — saving that to long-term memory." }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_fake_memory_2",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [
            {
              type: "tool_use",
              id: FAKE_CLAUDE_MEMORY_TOOL_ID,
              name: FAKE_CLAUDE_MEMORY_TOOL,
              input: { fact, tags: ["preference"] },
            },
          ],
        },
      }),
    ];
    for (const line of lines) onStdout(`${line}\n`);

    const answer = await this.callMemoryMcp(vm, "memory_write", { fact, tags: ["preference"] });
    onStdout(
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: FAKE_CLAUDE_MEMORY_TOOL_ID,
              content: answer,
              is_error: false,
            },
          ],
        },
      })}\n`,
    );
    onStdout(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_fake_memory_3",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: FAKE_CLAUDE_MEMORY_ASSISTANT_TEXT }],
        },
      })}\n`,
    );
    onStdout(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess_fake_playtest",
        cost_usd: 0.001,
        duration_ms: 42,
        num_turns: 2,
      })}\n`,
    );
  }

  /** The in-VM memory MCP server, emulated: write the request, wait for the answer. */
  private async callMemoryMcp(vm: FakeVm, tool: string, args: unknown): Promise<string> {
    const id = randomBytes(8).toString("hex");
    const requestPath = `${MEMORY_VM_DIR}/${MEMORY_VM_REQUEST_PREFIX}${id}.json`;
    const responsePath = `${MEMORY_VM_DIR}/${MEMORY_VM_RESPONSE_PREFIX}${id}.json`;
    vm.files.set(requestPath, JSON.stringify({ id, tool, args }));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const answer = vm.files.get(responsePath);
      if (answer !== undefined) {
        vm.files.delete(responsePath);
        return answer;
      }
      await sleep(20);
    }
    return JSON.stringify({
      ok: false,
      error: "timeout",
      message: "The memory service did not answer in time.",
    });
  }

  async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    const vm = this.vms.get(handle.userId);
    if (!vm || !vm.running) {
      throw new Error(`VM not running for user ${handle.userId}`);
    }

    // Collect stdout / stderr into strings for optional callbacks.
    let stdout = "";
    let stderr = "";
    const captureStdout = (chunk: string) => { stdout += chunk; };
    const captureStderr = (chunk: string) => { stderr += chunk; };
    const onStdout = opts?.onStdout ?? captureStdout;
    const onStderr = opts?.onStderr ?? captureStderr;

    // Simulate timeout / abort
    if (opts?.signal?.aborted) {
      throw new Error("Aborted");
    }

    if (cmd.length === 0) {
      return { exitCode: 0 };
    }

    const [prog, ...rest] = cmd;

    // Local playtests have no Claude Code binary in the fake VM. Replay a
    // recorded stream-json transcript so the full runtime pipeline still runs.
    if (this.replayClaude && isClaudeCommand(prog)) {
      const fact = memoryFactFromPrompt(claudePrompt(cmd));
      if (fact !== null) {
        await this.replayMemoryClaude(vm, fact, onStdout);
        return { exitCode: 0 };
      }
      await this.replayTranscript(handle, transcriptForClaude(cmd), opts, onStdout);
      // A run whose system prompt carries the account's long-term memory
      // starts with the agent recalling it, so a playtest can see that the
      // memory survived into the next run.
      const recalled = recalledMemoryFromSystemPrompt(systemPromptFor(cmd));
      if (recalled) {
        onStdout(
          `${JSON.stringify({
            type: "assistant",
            message: {
              id: "msg_fake_memory_recall",
              role: "assistant",
              model: "claude-sonnet-5-5",
              content: [{ type: "text", text: recalledMemoryAssistantText(recalled) }],
            },
          })}\n`,
        );
      }
      return { exitCode: 0 };
    }

    // Support simple file operations for test assertions.
    switch (prog) {
      case "echo":
        onStdout(rest.join(" ") + "\n");
        break;
      case "cat": {
        const file = rest[rest.length - 1];
        const content = vm.files.get(file);
        if (content === undefined) {
          onStderr(`cat: ${file}: No such file or directory\n`);
          return { exitCode: 1 };
        }
        onStdout(content);
        break;
      }
      case "pwd":
        onStdout("/workspace\n");
        break;
      case "mkdir":
        // no-op in fake
        break;
      case "rm": {
        // Library seed reconciliation uses `rm -rf -- <path>`. Mirror the
        // filesystem semantics needed by persistent-VM tests, including not
        // following a final symlink and accepting an absent path with -f.
        let recursive = false;
        let force = false;
        let options = true;
        const targets: string[] = [];
        for (const arg of rest) {
          if (options && arg === "--") {
            options = false;
            continue;
          }
          if (options && arg.startsWith("-")) {
            recursive ||= arg.includes("r") || arg.includes("R");
            force ||= arg.includes("f");
            continue;
          }
          targets.push(arg);
        }
        for (const target of targets) {
          const normalized = normalizeFakePath(target);
          if (vm.links.delete(normalized)) continue;
          vm.files.delete(normalized);
          vm.mtimes.delete(normalized);
          if (recursive) {
            const prefix = `${normalized}/`;
            for (const filePath of [...vm.files.keys()]) {
              if (filePath.startsWith(prefix)) {
                vm.files.delete(filePath);
                vm.mtimes.delete(filePath);
              }
            }
            for (const linkPath of [...vm.links.keys()]) {
              if (linkPath.startsWith(prefix)) vm.links.delete(linkPath);
            }
          }
        }
        if (targets.length === 0 && !force) return { exitCode: 1 };
        break;
      }
      case "false":
        return { exitCode: 1 };
      case "true":
        // no-op
        break;
      case "du": {
        // `du -sk <path>` -> "<kilobytes>\t<path>"; usage is the total utf8
        // byte size of the fake files under the target path.
        const target = rest.length > 0 ? rest[rest.length - 1] : WORKSPACE_ROOT;
        const prefix = target.endsWith("/") ? target : `${target}/`;
        let bytes = 0;
        for (const [filePath, content] of vm.files) {
          if (filePath === target || filePath.startsWith(prefix)) {
            bytes += Buffer.byteLength(content, "utf8");
          }
        }
        onStdout(`${Math.ceil(bytes / 1024)}\t${target}\n`);
        break;
      }
      default:
        // Unknown commands are silently "successful".
        onStdout("");
        break;
    }

    return { exitCode: 0 };
  }

  /**
   * Emit transcript lines in order. When the recorded agent calls ask_user,
   * simulate the VM ask server: write the pending file, block until the
   * harness writes the answer file, then continue. This makes the local e2e
   * exercise the real pause/resume plumbing without a live MCP server.
   */
  private async replayTranscript(
    handle: VmHandle,
    lines: readonly string[],
    opts: ExecOptions | undefined,
    onStdout: (chunk: string) => void,
  ): Promise<void> {
    let askIndex = 0;
    for (const line of lines) {
      if (opts?.signal?.aborted) throw new Error("Aborted");
      onStdout(`${line}\n`);
      const ask = askToolUse(line);
      if (ask) await this.fakeAskUser(handle, ask, opts, askIndex++);
    }
  }

  private async fakeAskUser(
    handle: VmHandle,
    ask: FakeAsk,
    opts: ExecOptions | undefined,
    index: number,
  ): Promise<void> {
    const id = `q_fake_${Date.now().toString(36)}_${index}`;
    const paths = questionPaths(id);
    await this.writeFile(
      handle,
      paths.pending,
      JSON.stringify({
        id,
        question: ask.question,
        options: ask.options,
        allowFreeText: ask.allowFreeText,
        createdAt: Date.now(),
      }),
    );
    const deadline = Date.now() + 120_000;
    try {
      while (Date.now() < deadline) {
        if (opts?.signal?.aborted) throw new Error("Aborted");
        try {
          const answer = JSON.parse(await this.readFile(handle, paths.answer)) as { status?: string };
          if (answer.status === "answered" || answer.status === "cancelled" || answer.status === "expired") return;
        } catch {
          // The harness has not written (or finished writing) the answer yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      const vm = this.vms.get(handle.userId);
      if (vm) {
        vm.files.delete(paths.pending);
        vm.files.delete(paths.answer);
      }
    }
  }

  async writeFile(handle: VmHandle, path: string, content: string): Promise<void> {
    const vm = this.getOrCreateVm(handle.userId);
    vm.files.set(path, content);
    vm.mtimes.set(path, Date.now());
  }

  async readFile(handle: VmHandle, path: string): Promise<string> {
    const vm = this.vms.get(handle.userId);
    if (!vm) throw new Error(`VM missing for user ${handle.userId}`);
    const content = vm.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  /** Metadata for one path: a known file, a directory that holds files, or nothing. */
  async stat(handle: VmHandle, path: string): Promise<VmFileStat> {
    const vm = this.vms.get(handle.userId);
    if (!vm) throw new VmFileError("not_found", `VM missing for user ${handle.userId}`);
    const content = vm.files.get(path);
    if (content !== undefined) {
      return {
        path,
        type: "file",
        size: Buffer.byteLength(content, "utf8"),
        modifiedAt: vm.mtimes.get(path),
      };
    }
    if (path === WORKSPACE_ROOT || this.childEntries(vm, path).length > 0) {
      return { path, type: "directory", size: 0 };
    }
    throw new VmFileError("not_found", `No such file or directory: ${path}`);
  }

  /** One level of a directory; directories are implied by the file paths. */
  async listDir(handle: VmHandle, path: string): Promise<VmDirEntry[]> {
    const vm = this.vms.get(handle.userId);
    if (!vm) throw new VmFileError("not_found", `VM missing for user ${handle.userId}`);
    if (vm.files.get(path) !== undefined) {
      throw new VmFileError("not_a_directory", `Not a directory: ${path}`);
    }
    const entries = this.childEntries(vm, path);
    if (path !== WORKSPACE_ROOT && entries.length === 0 && !this.hasDescendant(vm, path)) {
      throw new VmFileError("not_found", `No such file or directory: ${path}`);
    }
    return entries;
  }

  /** Raw bytes of a file, capped at maxBytes. */
  async readFileBytes(handle: VmHandle, path: string, maxBytes: number): Promise<VmFileBytes> {
    const vm = this.vms.get(handle.userId);
    if (!vm) throw new VmFileError("not_found", `VM missing for user ${handle.userId}`);
    const content = vm.files.get(path);
    if (content === undefined) {
      throw new VmFileError("not_found", `No such file or directory: ${path}`);
    }
    const bytes = Buffer.from(content, "utf8");
    const truncated = bytes.length > maxBytes;
    return {
      content: truncated ? bytes.subarray(0, maxBytes) : bytes,
      size: bytes.length,
      truncated,
    };
  }

  /** Entries directly under `path`; directories are derived from file paths. */
  private childEntries(vm: FakeVm, path: string): VmDirEntry[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const dirs = new Map<string, VmDirEntry>();
    const files: VmDirEntry[] = [];
    for (const [filePath, content] of vm.files) {
      if (!filePath.startsWith(prefix)) continue;
      const relative = filePath.slice(prefix.length);
      if (!relative) continue;
      const slash = relative.indexOf("/");
      if (slash === -1) {
        files.push({
          name: relative,
          path: filePath,
          type: "file",
          size: Buffer.byteLength(content, "utf8"),
          modifiedAt: vm.mtimes.get(filePath),
        });
        continue;
      }
      const name = relative.slice(0, slash);
      if (!dirs.has(name)) {
        dirs.set(name, { name, path: `${prefix}${name}`, type: "directory", size: 0 });
      }
    }
    return [...dirs.values(), ...files].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
    );
  }

  /** True when any file lives under `path`. */
  private hasDescendant(vm: FakeVm, path: string): boolean {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const filePath of vm.files.keys()) {
      if (filePath.startsWith(prefix)) return true;
    }
    return false;
  }

  async status(handle: VmHandle): Promise<VmState> {
    const vm = this.vms.get(handle.userId);
    if (!vm) return { status: "missing" };
    return { status: vm.running ? "running" : "stopped" };
  }

  async stop(handle: VmHandle): Promise<void> {
    const vm = this.vms.get(handle.userId);
    if (vm) vm.running = false;
  }

  async reset(handle: VmHandle): Promise<void> {
    const vm = this.vms.get(handle.userId);
    if (vm) {
      vm.files.clear();
      vm.links.clear();
      vm.running = false;
    }
  }

  async snapshot(handle: VmHandle, label: string): Promise<VmSnapshot> {
    validateSnapshotLabel(label);
    const vm = this.getOrCreateVm(handle.userId);
    const info: VmSnapshot = { label, createdAt: Date.now(), image: `fake-${handle.userId}:${label}` };
    vm.snapshots.set(label, {
      info,
      files: new Map(vm.files),
      links: new Map(vm.links),
      mtimes: new Map(vm.mtimes),
      running: vm.running,
    });
    return info;
  }

  async listSnapshots(handle: VmHandle): Promise<VmSnapshot[]> {
    const vm = this.vms.get(handle.userId);
    if (!vm) return [];
    return [...vm.snapshots.values()]
      .map((s) => s.info)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async restore(handle: VmHandle, label: string): Promise<void> {
    validateSnapshotLabel(label);
    const vm = this.vms.get(handle.userId);
    const snapshot = vm?.snapshots.get(label);
    if (!vm || !snapshot) {
      throw new Error(`Snapshot not found: ${label}`);
    }
    vm.files = new Map(snapshot.files);
    vm.links = new Map(snapshot.links);
    vm.mtimes = new Map(snapshot.mtimes);
    vm.running = snapshot.running;
  }

  async deleteSnapshot(handle: VmHandle, label: string): Promise<void> {
    validateSnapshotLabel(label);
    const vm = this.vms.get(handle.userId);
    if (!vm || !vm.snapshots.has(label)) {
      throw new Error(`Snapshot not found: ${label}`);
    }
    vm.snapshots.delete(label);
  }

  /**
   * Resolve a path the way `realpath` would inside a real VM: follow every
   * symlink and return the canonical absolute path. Missing paths are an
   * error unless allowMissing (write destinations).
   */
  async realpath(handle: VmHandle, path: string, opts?: RealpathOptions): Promise<string> {
    const vm = this.vms.get(handle.userId);
    if (!vm) throw new VmFileError("not_found", `VM missing for user ${handle.userId}`);
    const lexical = resolveWorkspacePath(path);
    const resolved = this.followLinks(vm, lexical, 0);
    // Containment is decided on the resolved path first: a link that escapes
    // /workspace is refused even when its target does not exist.
    assertWorkspaceContainment(resolved);
    if (!opts?.allowMissing && !this.pathExists(vm, resolved)) {
      throw new VmFileError("not_found", `No such file or directory: ${path}`);
    }
    return resolved;
  }

  /** Follow symlinks segment by segment (bounded against loops). */
  private followLinks(vm: FakeVm, raw: string, depth: number): string {
    if (depth > 32) {
      throw new VmPathError("invalid_path", "Too many levels of symbolic links.");
    }
    const normalized = normalizeFakePath(raw);
    const parts = normalized.split("/").filter((p) => p.length > 0);
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      out.push(parts[i]);
      const candidate = `/${out.join("/")}`;
      const target = vm.links.get(candidate);
      if (target === undefined) continue;
      out.pop();
      const base = out.length ? `/${out.join("/")}` : "/";
      const absoluteTarget = target.startsWith("/") ? target : `${base}/${target}`;
      const rest = parts.slice(i + 1).join("/");
      const combined = normalizeFakePath(rest ? `${absoluteTarget}/${rest}` : absoluteTarget);
      return this.followLinks(vm, combined, depth + 1);
    }
    return `/${out.join("/")}`;
  }

  /** Whether a fake path exists as a file, a directory, or a symlink. */
  private pathExists(vm: FakeVm, path: string): boolean {
    return (
      vm.files.has(path) ||
      vm.links.has(path) ||
      path === WORKSPACE_ROOT ||
      this.hasDescendant(vm, path)
    );
  }

  /** Test helper: create a symlink inside the fake VM. */
  symlink(userId: string, linkPath: string, target: string): void {
    const vm = this.getOrCreateVm(userId);
    vm.links.set(normalizeFakePath(linkPath), target);
  }

  /** Test helper: remove a fake symlink. */
  removeSymlink(userId: string, linkPath: string): void {
    this.vms.get(userId)?.links.delete(normalizeFakePath(linkPath));
  }

  /** The fake driver has no desktop; the shared contract says null. */
  async desktopEndpoint(_handle: VmHandle): Promise<VmDesktopEndpoint | null> {
    return null;
  }

  /**
   * The fake VM has no container network; loopback is the stand-in so unit
   * tests can run a local mock HTTP server as the "VM app" behind the proxy.
   */
  async containerIp(_handle: VmHandle): Promise<string | null> {
    return "127.0.0.1";
  }

  /** Test helper: directly inspect a file without going through readFile. */
  peekFile(userId: string, path: string): string | undefined {
    return this.vms.get(userId)?.files.get(path);
  }
}
