/**
 * Execution backends of the swarm-node runner.
 *
 * Two backends exist and the choice is made **locally**, by the human who
 * started the node — never by the server:
 *
 *   - `container` (default): every command runs inside a local Docker
 *     container built from the SwarmAgents desktop image. The container is
 *     isolated: it drops capabilities, refuses privilege escalation and only
 *     publishes the noVNC port on loopback.
 *   - `host`: every command runs directly on the machine. It is only
 *     available when the node was started with --host-mode.
 *
 * The server speaks the same command vocabulary in both cases; it can never
 * ask for the other one (see hostExec in the protocol, which the node
 * refuses unless host mode was enabled here).
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultStateDir } from "./credentials";

/** Result of one command run. */
export interface NodeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw stdout bytes (always collected, binary-safe). */
  stdoutBuffer?: Buffer;
}

/** Options for one command run. */
export interface NodeRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Keep stdout/stderr in memory (default true). */
  capture?: boolean;
  /** Collect stdout as raw bytes instead of text (binary-safe reads). */
  captureBinary?: boolean;
  /**
   * Abort the run: the child is killed and the promise rejects with an
   * "aborted" error. The server's cmd.cancel and a dropped tunnel both
   * drive this, so a cancelled command never keeps running unnoticed.
   */
  signal?: AbortSignal;
}

/** Metadata about one path (mirrors the app's VmFileStat). */
export interface NodeFileStat {
  path: string;
  type: "file" | "directory" | "other";
  size: number;
  modifiedAt?: number;
}

/** One entry of a directory listing (mirrors the app's VmDirEntry). */
export interface NodeDirEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size: number;
  modifiedAt?: number;
}

/** Raw bytes of a file (mirrors the app's VmFileBytes). */
export interface NodeFileBytes {
  content: Buffer;
  size: number;
  truncated: boolean;
}

/** A checkpoint of the sandbox (mirrors the app's VmSnapshot). */
export interface NodeSnapshot {
  label: string;
  createdAt: number;
  image?: string;
}

/** The desktop stream the node can offer (a noVNC websocket URL). */
export interface NodeDesktop {
  /** WebSocket URL of the noVNC client (loopback only). */
  url: string;
  /** VNC password of that desktop (injected server-side, never in a URL). */
  password: string;
}

/** What every backend can do. */
export interface NodeBackend {
  /** "container" or "host". */
  readonly kind: "container" | "host";
  /** Make sure a sandbox exists for the user. */
  ensure(userId: string): Promise<{ containerName: string }>;
  /** Run a command inside the sandbox. */
  exec(userId: string, cmd: string[], opts?: NodeRunOptions): Promise<{ exitCode: number }>;
  /** Write a file inside the sandbox. */
  writeFile(userId: string, path: string, content: string): Promise<void>;
  /** Read a text file from the sandbox. */
  readFile(userId: string, path: string): Promise<string>;
  /** Stat one path. */
  stat(userId: string, path: string): Promise<NodeFileStat>;
  /** List one directory level. */
  listDir(userId: string, path: string): Promise<NodeDirEntry[]>;
  /** Read raw bytes, capped. */
  readFileBytes(userId: string, path: string, maxBytes: number): Promise<NodeFileBytes>;
  /** Status of the sandbox. */
  status(userId: string): Promise<{ status: string; error?: string }>;
  /** Stop the sandbox (the workspace survives). */
  stop(userId: string): Promise<void>;
  /** Destroy the sandbox and its workspace. */
  reset(userId: string): Promise<void>;
  /** Create a checkpoint. */
  snapshot(userId: string, label: string): Promise<NodeSnapshot>;
  /** List the checkpoints. */
  listSnapshots(userId: string): Promise<NodeSnapshot[]>;
  /** Restore a checkpoint. */
  restore(userId: string, label: string): Promise<void>;
  /** The desktop stream, when this backend has one. */
  desktop(userId: string): Promise<NodeDesktop | null>;
  /** Password the server must use for this backend's desktop ("" when none). */
  desktopPassword(): string;
  /** Release everything (containers, display servers). */
  dispose(): Promise<void>;
}

/** Default desktop image (built from vm-image-desktop). */
export const DEFAULT_NODE_IMAGE = "swarm-vm:desktop";

/** In-container port of the noVNC web client. */
export const NODE_DESKTOP_PORT = 6080;

/** Workspace mount path inside the container. */
export const NODE_WORKSPACE = "/workspace";

/** Lowercase a user id into a safe container/volume name fragment. */
export function sanitizeUserId(userId: string): string {
  const out = userId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-");
  return out.replace(/^-|-$/g, "").slice(0, 48) || "user";
}

/** True when a `docker` executable is on PATH (no daemon round-trip). */
export function hasDocker(): boolean {
  const names = process.platform === "win32" ? ["docker.exe", "docker.cmd", "docker.bat"] : ["docker"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

/**
 * VNC password the node shows to the server.
 *
 * It comes from SWARM_NODE_VNC_PASSWORD when set, otherwise from a 0600 file
 * in the node's state directory (generated once). The password is never
 * logged; it travels to the server inside the authenticated hello frame and
 * from there only into the proxy's RFB handshake.
 */
export function resolveDesktopPassword(): string {
  const fromEnv = process.env.SWARM_NODE_VNC_PASSWORD;
  if (fromEnv) return fromEnv;
  const file = path.join(defaultStateDir(), "vnc-password");
  try {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (stored) return stored;
  } catch {
    /* not created yet */
  }
  const password = crypto.randomBytes(9).toString("base64url").slice(0, 12);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${password}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // An unwritable state dir must not stop the node; the container still
    // gets this process-lifetime password.
  }
  return password;
}

/** Run a command, streaming its output. Never uses a shell. */
export function runCommand(
  command: string,
  args: string[],
  opts: NodeRunOptions = {},
): Promise<NodeRunResult> {
  const capture = opts.capture !== false;
  if (opts.signal?.aborted) {
    return Promise.reject(new Error("Command aborted."));
  }
  return new Promise<NodeRunResult>((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error("Command aborted."));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, opts.timeoutMs)
        : null;
    timer?.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (capture) stdoutChunks.push(Buffer.from(chunk));
      opts.onStdout?.(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (capture) stderrChunks.push(Buffer.from(chunk));
      opts.onStderr?.(chunk.toString("utf8"));
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      const outBuffer = Buffer.concat(stdoutChunks);
      const errBuffer = Buffer.concat(stderrChunks);
      resolve({
        exitCode: code ?? (signal ? 130 : 0),
        stdout: opts.captureBinary ? "" : outBuffer.toString("utf8"),
        stderr: errBuffer.toString("utf8"),
        stdoutBuffer: outBuffer,
      });
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Environment names must look like shell variables. */
function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// ---------------------------------------------------------------------------
// Container backend
// ---------------------------------------------------------------------------

export interface ContainerBackendOptions {
  /** Image the sandbox runs (default swarm-vm:desktop). */
  image?: string;
  /** Memory ceiling of the container. */
  memory?: string;
  /** CPU ceiling of the container. */
  cpus?: string;
  /** PID ceiling of the container. */
  pidsLimit?: string;
  /** VNC password handed to the desktop image. */
  desktopPassword?: string;
  /** Start a noVNC desktop inside the container (default true). */
  desktop?: boolean;
  /** Injectable spawn (tests). */
  spawnFn?: typeof runCommand;
}

/**
 * Runs the agent sandbox inside a local Docker container.
 *
 * The container is created with the same hardening the server's docker
 * driver uses: no privilege escalation, all capabilities dropped except the
 * few a shell needs, an init process and a workspace volume. Only the noVNC
 * port is published, and only on loopback.
 */
export class ContainerBackend implements NodeBackend {
  readonly kind = "container";
  private readonly image: string;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pidsLimit: string;
  private readonly desktopPasswordValue: string;
  private readonly desktopEnabled: boolean;
  private readonly run: typeof runCommand;

  constructor(opts: ContainerBackendOptions = {}) {
    this.image = opts.image ?? process.env.SWARM_NODE_IMAGE ?? DEFAULT_NODE_IMAGE;
    this.memory = opts.memory ?? "4g";
    this.cpus = opts.cpus ?? "2";
    this.pidsLimit = opts.pidsLimit ?? "512";
    this.desktopPasswordValue = opts.desktopPassword ?? resolveDesktopPassword();
    this.desktopEnabled = opts.desktop ?? true;
    this.run = opts.spawnFn ?? runCommand;
  }

  private containerName(userId: string): string {
    return `swarm-byoc-${sanitizeUserId(userId)}`;
  }

  private volumeName(userId: string): string {
    return `swarm-byoc-${sanitizeUserId(userId)}-workspace`;
  }

  private snapshotRepo(userId: string): string {
    return `swarm-byoc-${sanitizeUserId(userId)}-snap`;
  }

  /** Build the `docker run` arguments of the sandbox container. */
  runArgs(userId: string): string[] {
    const args = [
      "run",
      "-d",
      "--name",
      this.containerName(userId),
      "--init",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "KILL",
      "--memory",
      this.memory,
      "--cpus",
      this.cpus,
      "--pids-limit",
      this.pidsLimit,
      "--shm-size",
      "1g",
      "-v",
      `${this.volumeName(userId)}:${NODE_WORKSPACE}`,
      "-w",
      NODE_WORKSPACE,
    ];
    if (this.desktopEnabled) {
      // Published on loopback only, with a random host port: the node needs
      // to reach the noVNC client, the world does not.
      args.push("-p", `127.0.0.1::${NODE_DESKTOP_PORT}`);
      args.push("-e", "SWARM_VNC_PASSWORD");
    }
    args.push("--restart", "unless-stopped");
    args.push(this.image);
    if (!this.desktopEnabled) args.push("tail", "-f", "/dev/null");
    return args;
  }

  /** Build the `docker exec` arguments for a command. */
  execArgs(userId: string, cmd: string[], opts: NodeRunOptions = {}): string[] {
    const args = ["exec"];
    if (opts.stdin !== undefined) args.push("-i");
    if (opts.cwd) args.push("-w", opts.cwd);
    for (const name of Object.keys(opts.env ?? {})) {
      if (!isValidEnvName(name)) continue;
      args.push("-e", name);
    }
    args.push("--");
    args.push(this.containerName(userId));
    args.push(...cmd);
    return args;
  }

  private async docker(args: string[], opts: NodeRunOptions = {}): Promise<NodeRunResult> {
    return this.run("docker", args, opts);
  }

  async ensure(userId: string): Promise<{ containerName: string }> {
    const name = this.containerName(userId);
    const inspect = await this.docker(["container", "inspect", "-f", "{{.State.Status}}", name]);
    if (inspect.exitCode === 0) {
      const status = inspect.stdout.trim();
      if (status === "running") return { containerName: name };
      await this.docker(["start", name]);
      return { containerName: name };
    }
    await this.docker(["volume", "create", this.volumeName(userId)]);
    const env: Record<string, string> = {};
    if (this.desktopEnabled && this.desktopPasswordValue) env.SWARM_VNC_PASSWORD = this.desktopPasswordValue;
    const created = await this.docker(this.runArgs(userId), { env });
    if (created.exitCode !== 0) {
      throw new Error(
        `Could not start the sandbox container (${name}): ${created.stderr.trim() || "docker failed"}`,
      );
    }
    return { containerName: name };
  }

  async exec(userId: string, cmd: string[], opts: NodeRunOptions = {}): Promise<{ exitCode: number }> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(opts.env ?? {})) {
      if (!isValidEnvName(name)) continue;
      env[name] = value;
    }
    const result = await this.docker(this.execArgs(userId, cmd, opts), {
      cwd: opts.cwd,
      env: Object.keys(env).length > 0 ? env : undefined,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    return { exitCode: result.exitCode };
  }

  async writeFile(userId: string, filePath: string, content: string): Promise<void> {
    if (!filePath.startsWith("/")) throw new Error("Path must be absolute.");
    if (filePath.includes("\0") || filePath.includes('"')) throw new Error("Invalid path.");
    const parent = path.posix.dirname(filePath);
    await this.docker(this.execArgs(userId, ["mkdir", "-p", parent]));
    const result = await this.docker(
      this.execArgs(userId, ["sh", "-c", 'cat > "$1"', "sh", filePath], { stdin: content }),
      { stdin: content },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not write the file.");
  }

  async readFile(userId: string, filePath: string): Promise<string> {
    const result = await this.docker(this.execArgs(userId, ["cat", "--", filePath]));
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not read the file.");
    return result.stdout;
  }

  async stat(userId: string, filePath: string): Promise<NodeFileStat> {
    const result = await this.docker(
      this.execArgs(userId, ["stat", "-c", "%F\t%s\t%Y", "--", filePath]),
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not stat the path.");
    const [kind, size, mtime] = result.stdout.trim().split("\t");
    return {
      path: filePath,
      type: kind === "directory" ? "directory" : kind === "regular file" ? "file" : "other",
      size: Number(size) || 0,
      modifiedAt: mtime ? Number(mtime) * 1000 : undefined,
    };
  }

  async listDir(userId: string, dirPath: string): Promise<NodeDirEntry[]> {
    const result = await this.docker(
      this.execArgs(userId, [
        "find",
        dirPath,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-printf",
        "%y\\0%s\\0%T@\\0%f\\0",
      ]),
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not list the directory.");
    const parts = result.stdout.split("\0").filter((part) => part.length > 0);
    const entries: NodeDirEntry[] = [];
    for (let i = 0; i + 3 < parts.length; i += 4) {
      const [kind, size, mtime, name] = parts.slice(i, i + 4);
      entries.push({
        name,
        path: path.posix.join(dirPath, name),
        type: kind === "d" ? "directory" : kind === "f" ? "file" : "other",
        size: Number(size) || 0,
        modifiedAt: mtime ? Math.floor(Number(mtime) * 1000) : undefined,
      });
    }
    return entries;
  }

  async readFileBytes(
    userId: string,
    filePath: string,
    maxBytes: number,
  ): Promise<NodeFileBytes> {
    const stat = await this.stat(userId, filePath);
    const result = await this.docker(
      this.execArgs(userId, ["head", "-c", String(maxBytes), "--", filePath]),
      { captureBinary: true },
    );
    const content = result.stdoutBuffer ?? Buffer.alloc(0);
    return {
      content,
      size: stat.size,
      truncated: stat.size > content.length,
    };
  }

  async status(userId: string): Promise<{ status: string; error?: string }> {
    let result: NodeRunResult;
    try {
      result = await this.docker([
        "container",
        "inspect",
        "-f",
        "{{.State.Status}}",
        this.containerName(userId),
      ]);
    } catch (err) {
      // A status probe must answer, not throw: a machine without Docker on
      // PATH (spawn ENOENT) reports that plainly so the user can install it
      // or restart the node with --host-mode.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return {
          status: "error",
          error: "Docker is not installed or not on PATH on this computer. Install Docker, or restart the node with --host-mode.",
        };
      }
      throw err;
    }
    if (result.exitCode !== 0) return { status: "missing" };
    const status = result.stdout.trim();
    if (status === "running") return { status: "running" };
    if (status === "created" || status === "restarting") return { status: "creating" };
    return { status: "stopped" };
  }

  async stop(userId: string): Promise<void> {
    await this.docker(["stop", this.containerName(userId)]);
  }

  async reset(userId: string): Promise<void> {
    await this.docker(["rm", "-f", this.containerName(userId)]);
    await this.docker(["volume", "rm", "-f", this.volumeName(userId)]);
  }

  async snapshot(userId: string, label: string): Promise<NodeSnapshot> {
    const image = `${this.snapshotRepo(userId)}:${label}`;
    const result = await this.docker([
      "commit",
      this.containerName(userId),
      image,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not create the snapshot.");
    return { label, createdAt: Date.now(), image };
  }

  async listSnapshots(userId: string): Promise<NodeSnapshot[]> {
    const result = await this.docker([
      "images",
      "--filter",
      `reference=${this.snapshotRepo(userId)}`,
      "--format",
      "{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}",
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref, created] = line.split("\t");
        const label = ref.slice(ref.lastIndexOf(":") + 1);
        const createdAt = Date.parse(created ?? "");
        return { label, createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(), image: ref };
      });
  }

  async restore(userId: string, label: string): Promise<void> {
    const image = `${this.snapshotRepo(userId)}:${label}`;
    await this.docker(["rm", "-f", this.containerName(userId)]);
    const env: Record<string, string> = {};
    if (this.desktopEnabled && this.desktopPasswordValue) env.SWARM_VNC_PASSWORD = this.desktopPasswordValue;
    const args = this.runArgs(userId);
    const imageIndex = args.indexOf(this.image);
    if (imageIndex >= 0) args[imageIndex] = image;
    const result = await this.docker(args, { env });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not restore the snapshot.");
  }

  async desktop(userId: string): Promise<NodeDesktop | null> {
    if (!this.desktopEnabled) return null;
    // The container writes the password it really booted with to a 0600 file.
    // Reading it back covers a container created by an older node (or one
    // started by hand): the server always gets a password that works.
    let password = this.desktopPasswordValue;
    const stored = await this.docker(
      this.execArgs(userId, ["cat", "--", "/home/node/.vnc/.swarm-vnc-password"]),
    );
    if (stored.exitCode === 0 && stored.stdout.trim()) password = stored.stdout.trim();
    const result = await this.docker([
      "port",
      this.containerName(userId),
      `${NODE_DESKTOP_PORT}/tcp`,
    ]);
    if (result.exitCode !== 0) return null;
    const mapping = result.stdout.trim().split("\n")[0]?.trim();
    if (!mapping) return null;
    const port = mapping.split(":").pop();
    if (!port) return null;
    return {
      url: `ws://127.0.0.1:${port}/websockify`,
      password,
    };
  }

  /** Password the container's desktop boots with ("" when disabled). */
  desktopPassword(): string {
    return this.desktopEnabled ? this.desktopPasswordValue : "";
  }

  async dispose(): Promise<void> {
    /* containers outlive the node on purpose — they are the user's VM. */
  }
}

// ---------------------------------------------------------------------------
// Host backend
// ---------------------------------------------------------------------------

export interface HostBackendOptions {
  /** Root directory of the sandboxes (default ~/.swarm-node/workspaces). */
  root?: string;
  /** Desktop provider (Xvfb + x11vnc + websockify) for --host-mode. */
  desktop?: NodeHostDesktop | null;
}

/** A host-mode desktop the backend can offer. */
export interface NodeHostDesktop {
  /** URL of the noVNC websocket. */
  url: string;
  /** VNC password. */
  password: string;
  /** Release the display server. */
  stop: () => Promise<void>;
}

/**
 * Runs the agent sandbox directly on the user's machine.
 *
 * Only reachable when the node was started with --host-mode. The file API
 * stays inside the user's workspace directory; shell commands run with the
 * user's own permissions, which is exactly what opting in means.
 */
export class HostBackend implements NodeBackend {
  readonly kind = "host";
  private readonly root: string;
  private readonly desktopProvider: NodeHostDesktop | null;

  constructor(opts: HostBackendOptions = {}) {
    this.root =
      opts.root ??
      path.join(process.env.SWARM_NODE_HOME ?? path.join(process.env.HOME ?? ".", ".swarm-node"), "workspaces");
    this.desktopProvider = opts.desktop ?? null;
  }

  /** The workspace directory of a user. */
  workspace(userId: string): string {
    return path.join(this.root, sanitizeUserId(userId));
  }

  /**
   * Resolve a driver path inside the workspace; refuses to escape it.
   *
   * The VM contract addresses the sandbox as `/workspace` (that is the
   * container volume). Host mode has no such mount, so the same absolute
   * paths are mapped onto this user's workspace directory: `/workspace/a`
   * and `/workspace` become `<workspace>/a` and `<workspace>`.
   */
  resolve(userId: string, target: string): string {
    const base = path.resolve(this.workspace(userId));
    let relative = target.replace(/^\/+/, "");
    if (relative === "workspace") {
      relative = "";
    } else if (relative.startsWith(`workspace${path.posix.sep}`)) {
      relative = relative.slice("workspace/".length);
    }
    const resolved = path.resolve(base, relative);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error("Path is outside of the workspace.");
    }
    return resolved;
  }

  async ensure(userId: string): Promise<{ containerName: string }> {
    fs.mkdirSync(this.workspace(userId), { recursive: true });
    return { containerName: `host-${sanitizeUserId(userId)}` };
  }

  async exec(userId: string, cmd: string[], opts: NodeRunOptions = {}): Promise<{ exitCode: number }> {
    if (cmd.length === 0) throw new Error("No command given.");
    await this.ensure(userId);
    const cwd = opts.cwd ? this.resolve(userId, opts.cwd) : this.workspace(userId);
    const result = await runCommand(cmd[0], cmd.slice(1), {
      cwd,
      env: opts.env,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    return { exitCode: result.exitCode };
  }

  async writeFile(userId: string, filePath: string, content: string): Promise<void> {
    const target = this.resolve(userId, filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  async readFile(userId: string, filePath: string): Promise<string> {
    return fs.readFileSync(this.resolve(userId, filePath), "utf8");
  }

  async stat(userId: string, filePath: string): Promise<NodeFileStat> {
    const target = this.resolve(userId, filePath);
    const stats = fs.statSync(target);
    return {
      path: filePath,
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      size: stats.size,
      modifiedAt: stats.mtimeMs,
    };
  }

  async listDir(userId: string, dirPath: string): Promise<NodeDirEntry[]> {
    const target = this.resolve(userId, dirPath);
    return fs.readdirSync(target, { withFileTypes: true }).map((entry) => {
      const full = path.join(target, entry.name);
      let size = 0;
      let modifiedAt: number | undefined;
      try {
        const stats = fs.statSync(full);
        size = stats.size;
        modifiedAt = stats.mtimeMs;
      } catch {
        /* ignore */
      }
      return {
        name: entry.name,
        path: path.join(dirPath, entry.name),
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size,
        modifiedAt,
      };
    });
  }

  async readFileBytes(userId: string, filePath: string, maxBytes: number): Promise<NodeFileBytes> {
    const target = this.resolve(userId, filePath);
    const stats = fs.statSync(target);
    const handle = fs.openSync(target, "r");
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stats.size));
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
      return {
        content: buffer.subarray(0, read),
        size: stats.size,
        truncated: stats.size > read,
      };
    } finally {
      fs.closeSync(handle);
    }
  }

  async status(userId: string): Promise<{ status: string; error?: string }> {
    if (!fs.existsSync(this.workspace(userId))) return { status: "missing" };
    return { status: "running" };
  }

  async stop(_userId: string): Promise<void> {
    /* Nothing to stop: the host is always up. */
  }

  async reset(userId: string): Promise<void> {
    const workspace = this.workspace(userId);
    if (!fs.existsSync(workspace)) return;
    for (const entry of fs.readdirSync(workspace)) {
      fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
    }
  }

  async snapshot(userId: string, label: string): Promise<NodeSnapshot> {
    const workspace = this.workspace(userId);
    const snapshotDir = path.join(path.dirname(workspace), "snapshots", sanitizeUserId(userId));
    const target = path.join(snapshotDir, label);
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(workspace, target, { recursive: true });
    return { label, createdAt: Date.now(), image: target };
  }

  async listSnapshots(userId: string): Promise<NodeSnapshot[]> {
    const snapshotDir = path.join(path.dirname(this.workspace(userId)), "snapshots", sanitizeUserId(userId));
    if (!fs.existsSync(snapshotDir)) return [];
    return fs
      .readdirSync(snapshotDir)
      .map((label) => {
        const stats = fs.statSync(path.join(snapshotDir, label));
        return { label, createdAt: stats.mtimeMs, image: path.join(snapshotDir, label) };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async restore(userId: string, label: string): Promise<void> {
    const snapshotDir = path.join(path.dirname(this.workspace(userId)), "snapshots", sanitizeUserId(userId));
    const source = path.join(snapshotDir, label);
    if (!fs.existsSync(source)) throw new Error(`No snapshot named ${label}.`);
    await this.reset(userId);
    fs.cpSync(source, this.workspace(userId), { recursive: true });
  }

  async desktop(_userId: string): Promise<NodeDesktop | null> {
    if (!this.desktopProvider) return null;
    return { url: this.desktopProvider.url, password: this.desktopProvider.password };
  }

  /** Password the host desktop was started with ("" when none). */
  desktopPassword(): string {
    return this.desktopProvider?.password ?? "";
  }

  async dispose(): Promise<void> {
    if (this.desktopProvider) await this.desktopProvider.stop();
  }
}
