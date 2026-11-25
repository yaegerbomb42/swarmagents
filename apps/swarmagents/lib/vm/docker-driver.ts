// Server-only Docker VM driver.
// Spawns one long-lived container per user with a named volume for persistence.
// All docker invocations use argv arrays (no shell strings) to prevent injection.

import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import { recordAudit } from "../audit";
import { vmStreamError } from "./stream-errors";
import { listLocalUserIds } from "../users";
import type {
  VmDriver,
  VmHandle,
  ExecOptions,
  ExecResult,
  VmState,
  VmDirEntry,
  VmFileBytes,
  VmFileStat,
  VmSnapshot,
  VmDesktopEndpoint,
  RealpathOptions,
} from "./types";
import { VmFileError, VmPathError, assertWorkspaceContainment, resolveWorkspacePath } from "./files";
import {
  DEFAULT_VM_CPUS,
  DEFAULT_VM_DESKTOP_MEMORY,
  DEFAULT_VM_MEMORY,
  DEFAULT_VM_PIDS,
  resolveVmLimits,
  validateCpuLimit,
  validateMemoryLimit,
  validatePidsLimit,
} from "./limits";

/** Single-signature spawn type (avoids the overload intersection confusion). */
export type DockerSpawnFn = (command: string, args: readonly string[], options?: SpawnOptions) => ChildProcess;

/** Child stdio stream or the `null` spawn may hand back for a closed channel. */
type ChildStream = NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined;

/**
 * Attach an `error` listener to a child stdio stream.
 *
 * Without a listener Node re-emits a stream error as an uncaught exception
 * (EventEmitter's default `error` behavior), which kills the whole server.
 * Every stream a spawn hands back goes through here. `onError` receives the
 * failure so the owning promise can settle with a typed stream error.
 */
function watchChildStream(stream: ChildStream, onError?: (err: unknown) => void): void {
  if (!stream) return;
  stream.on("error", (err: unknown) => onError?.(err));
}

/**
 * Write `data` to a child's stdin respecting backpressure, and report a broken
 * pipe through `onError` instead of letting it escape as an uncaught event.
 * `pipeline` owns both stream listeners and destroys the source on failure.
 */
function writeChildStdin(
  stdin: NodeJS.WritableStream,
  data: string | Buffer,
  onError: (err: unknown) => void,
): void {
  // Explicit listener first: pipeline also listens, but this guarantees the
  // `error` event is never unhandled even if pipeline tears down early.
  watchChildStream(stdin, onError);
  pipeline(Readable.from([data]), stdin, (err) => {
    if (err) onError(err);
  });
}

const DEFAULT_IMAGE = "swarm-vm:claude";
export const SWARM_VM_IMAGE = process.env.SWARM_VM_IMAGE ?? DEFAULT_IMAGE;

/**
 * Desktop mode (SWARM_VM_DESKTOP=1). When enabled the driver creates the VM
 * from the desktop image (SWARM_VM_DESKTOP_IMAGE, default swarm-vm:desktop),
 * passes DISPLAY=:1, seeds a generated VNC password file before startup, sizes
 * /dev/shm for a browser (--shm-size=1g), and never publishes any port.
 * When unset everything behaves exactly as before with swarm-vm:claude.
 */
export const SWARM_VM_DESKTOP = process.env.SWARM_VM_DESKTOP === "1";
export const SWARM_VM_LOCAL_PUBLISH = process.env.SWARM_VM_LOCAL_PUBLISH === "1";
export const DEFAULT_DESKTOP_IMAGE = "swarm-vm:desktop";
export const SWARM_VM_DESKTOP_IMAGE =
  (process.env.SWARM_VM_DESKTOP_IMAGE ?? "").trim() || DEFAULT_DESKTOP_IMAGE;
/** X display the desktop runs on inside the container. */
export const DESKTOP_DISPLAY = ":1";
/** In-container VNC web client port (plain HTTP + WebSocket). */
export const DESKTOP_VNC_PORT = 6080;
/** /dev/shm size for the container (Chromium needs > 64MB). */
export const DESKTOP_SHM_SIZE = "1g";
/** Env var carrying the generated VNC password into the container. */
export const DESKTOP_VNC_PASSWORD_ENV = "SWARM_VNC_PASSWORD";
/** Where the container stores the plaintext copy the driver can re-read. */
export const DESKTOP_VNC_PASSWORD_FILE = "/home/node/.vnc/.swarm-vnc-password";

/**
 * Tar flags stamping a seeded desktop file as node-owned (uid/gid 1000).
 * BSD tar (macOS) spells ownership `--uid/--gid` and needs `--no-xattrs` to
 * keep macOS-only metadata out of the archive; GNU tar (Linux) rejects both
 * spellings and uses `--owner=1000 --group=1000` instead (and never writes
 * macOS metadata, so no xattrs flag is needed). Every other platform falls
 * back to the GNU spelling, which is the portable one for the Linux Docker
 * hosts desktop mode runs on. Defaults to the current host's platform; pass
 * one explicitly to assert the other spelling in tests.
 */
export function desktopVncTarArgs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["--no-xattrs", "--uid", "1000", "--gid", "1000"];
  return ["--owner=1000", "--group=1000"];
}

/** Env var selecting the OCI runtime used to create VM containers. */
export const VM_RUNTIME_ENV = "SWARM_VM_RUNTIME";

/**
 * Runtimes allowed for {@link VM_RUNTIME_ENV}. Only names on this list may
 * reach a `docker run --runtime` argv; anything else is a configuration
 * error. `runc` is Docker's default; `runsc` is gVisor.
 */
export const VM_RUNTIME_ALLOWLIST = ["runc", "runsc"] as const;

/** Typed error thrown when a configured runtime is not usable. */
export class VmRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmRuntimeError";
  }
}

/**
 * Validate an OCI runtime name against the allowlist. Returns the trimmed
 * canonical name; throws a {@link VmRuntimeError} for anything else.
 */
export function validateVmRuntime(value: string, label = VM_RUNTIME_ENV): string {
  const raw = (value ?? "").trim();
  if (!(VM_RUNTIME_ALLOWLIST as readonly string[]).includes(raw)) {
    throw new VmRuntimeError(
      `Invalid ${label} value ${JSON.stringify(value)}: expected one of ` +
        `${VM_RUNTIME_ALLOWLIST.join(", ")}.`,
    );
  }
  return raw;
}

/**
 * Resolve the effective runtime from the environment, with an explicit
 * override (constructor option) taking precedence. Unset resolves to
 * undefined — Docker's default runtime is used and no `--runtime` flag is
 * emitted. Invalid values throw a {@link VmRuntimeError} naming the variable
 * that has to be fixed.
 */
export function resolveVmRuntime(
  env: Record<string, string | undefined> = process.env,
  override?: string,
): string | undefined {
  const overrideTrimmed = override?.trim();
  if (overrideTrimmed) return validateVmRuntime(overrideTrimmed, "runtime");
  const raw = env[VM_RUNTIME_ENV];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : validateVmRuntime(trimmed, VM_RUNTIME_ENV);
}

/**
 * Detect Docker's "runtime missing" failure. When a `--runtime` name is not
 * registered with the daemon, Docker fails the run with a message like:
 *   docker: Error response from daemon: unknown or invalid runtime name: runsc.
 */
export function isRuntimeMissingError(stderr: string): boolean {
  return (
    /unknown or invalid runtime name\s*:\s*\S+/.test(stderr) ||
    /\bruntime\b[^\n]*\bnot found\b/i.test(stderr)
  );
}

/** Env var selecting the docker network VM containers are attached to. */
export const VM_NETWORK_ENV = "SWARM_VM_NETWORK";

/**
 * Docker network names: must start with an alphanumeric character and may
 * contain letters, digits, `_`, `.` and `-`. Kept strict so a value can
 * never smuggle a flag into the `docker run` argv.
 */
const VM_NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Networks that would defeat the point of a dedicated VM network: `host`
 * puts the container in the host network namespace, so the VM would share
 * the host's egress path and the network-scoped firewall rules would not
 * apply to it.
 */
const VM_NETWORK_DENIED = new Set(["host"]);

/** Typed error thrown when a configured VM network is not usable. */
export class VmNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmNetworkError";
  }
}

/**
 * Validate a docker network name. Returns the trimmed canonical name;
 * throws a {@link VmNetworkError} for anything else.
 */
export function validateVmNetwork(value: string, label = VM_NETWORK_ENV): string {
  const raw = (value ?? "").trim();
  if (!VM_NETWORK_NAME_RE.test(raw)) {
    throw new VmNetworkError(
      `Invalid ${label} value ${JSON.stringify(value)}: expected a docker network name ` +
        `(letters, digits, "_", ".", "-", starting with a letter or digit).`,
    );
  }
  if (VM_NETWORK_DENIED.has(raw.toLowerCase())) {
    throw new VmNetworkError(
      `Invalid ${label} value ${JSON.stringify(value)}: the "host" network is not allowed ` +
        `because it would give every VM the host's network namespace. Use a dedicated ` +
        `bridge network instead (e.g. swarm-vms).`,
    );
  }
  return raw;
}

/**
 * Resolve the effective docker network from the environment, with an
 * explicit override (constructor option) taking precedence. Unset (or
 * blank) resolves to undefined — the container is created on Docker's
 * default bridge, exactly as before this option existed. Invalid values
 * throw a {@link VmNetworkError} naming the variable that has to be fixed.
 */
export function resolveVmNetwork(
  env: Record<string, string | undefined> = process.env,
  override?: string,
): string | undefined {
  const overrideTrimmed = override?.trim();
  if (overrideTrimmed) return validateVmNetwork(overrideTrimmed, "network");
  const raw = env[VM_NETWORK_ENV];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : validateVmNetwork(trimmed, VM_NETWORK_ENV);
}

// Container resource limits — overridable via env, validated in lib/vm/limits.
export const SWARM_VM_MEMORY = (process.env.SWARM_VM_MEMORY ?? "").trim() || DEFAULT_VM_MEMORY;
export const SWARM_VM_CPUS = (process.env.SWARM_VM_CPUS ?? "").trim() || DEFAULT_VM_CPUS;
export const SWARM_VM_PIDS =
  (process.env.SWARM_VM_PIDS ?? process.env.SWARM_VM_PIDS_LIMIT ?? "").trim() || DEFAULT_VM_PIDS;
/** Legacy alias for {@link SWARM_VM_PIDS}. */
export const SWARM_VM_PIDS_LIMIT = SWARM_VM_PIDS;

/**
 * Capabilities kept after `--cap-drop ALL`: the minimum a dev box needs
 * (change file ownership, own files, switch user, signal processes).
 */
export const VM_CAPABILITIES = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETUID",
  "SETGID",
  "KILL",
] as const;

/** Pull timeout for SWARM_VM_PULL=1, ms. Default 2 min. */
export const SWARM_VM_PULL_TIMEOUT_MS = Number(process.env.SWARM_VM_PULL_TIMEOUT_MS ?? "120000");

/** Read a positive timeout (ms) from the environment, falling back when unset/invalid. */
function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Per-command-class deadlines for docker CLI calls (FIX-05). Every `run()` /
 * `runRaw()` call carries one of these by default, so a wedged Docker daemon
 * fails the operation with a typed timeout instead of holding the per-user
 * VM lock forever. An explicit `timeoutMs` at a call site (e.g. the pull
 * deadline above) always wins over the class default.
 */
export type DockerTimeoutClass = "quick" | "standard" | "long" | "commit";

/** Read-only metadata calls (`inspect`, `ls`, `info`): they answer in ms or the daemon is wedged. */
export const SWARM_VM_DOCKER_QUICK_TIMEOUT_MS = envTimeoutMs("SWARM_VM_DOCKER_QUICK_TIMEOUT_MS", 15_000);
/** Ordinary mutations (create/remove/rename/start/stop/exec file ops). `docker stop` alone waits out a 10s grace. */
export const SWARM_VM_DOCKER_TIMEOUT_MS = envTimeoutMs("SWARM_VM_DOCKER_TIMEOUT_MS", 30_000);
/** Container create/run and bulk copies (`cp` of a workspace tree). */
export const SWARM_VM_DOCKER_LONG_TIMEOUT_MS = envTimeoutMs("SWARM_VM_DOCKER_LONG_TIMEOUT_MS", 120_000);
/** `docker commit` of a large container filesystem can legitimately take minutes. */
export const SWARM_VM_DOCKER_COMMIT_TIMEOUT_MS = envTimeoutMs("SWARM_VM_DOCKER_COMMIT_TIMEOUT_MS", 300_000);

/** Built-in per-class docker CLI deadlines (env-tunable via the constants above). */
export const DEFAULT_DOCKER_TIMEOUTS: Record<DockerTimeoutClass, number> = {
  quick: SWARM_VM_DOCKER_QUICK_TIMEOUT_MS,
  standard: SWARM_VM_DOCKER_TIMEOUT_MS,
  long: SWARM_VM_DOCKER_LONG_TIMEOUT_MS,
  commit: SWARM_VM_DOCKER_COMMIT_TIMEOUT_MS,
};

/**
 * Default cap on stdout buffered by one docker CLI call. Every `run`/`runRaw`
 * call is deadline-bound, but a deadline bounds time, not bytes: a chatty
 * command (`docker pull` progress, `cat` of a huge file) could allocate
 * gigabytes before the timer fires. Past the cap the stream is still drained
 * (so the child never blocks on a full pipe) but discarded, and the result
 * is flagged `stdoutTruncated`.
 */
export const MAX_RUN_STDOUT_BYTES = 32 * 1024 * 1024;
/**
 * Default cap on stderr retained by one docker CLI call. Only the tail is
 * kept — the actionable part of a failure message is at the end.
 */
export const MAX_RUN_STDERR_BYTES = 1024 * 1024;

/** Classify a docker argv into its deadline class. Exported for tests. */
export function dockerTimeoutClassFor(args: readonly string[]): DockerTimeoutClass {
  const [cmd, sub] = args;
  if (cmd === "commit") return "commit";
  if (cmd === "run" || cmd === "create" || cmd === "cp" || cmd === "pull") return "long";
  if (cmd === "info") return "quick";
  if ((cmd === "container" || cmd === "image") && sub === "inspect") return "quick";
  if (cmd === "volume" && sub === "ls") return "quick";
  return "standard";
}

/** Typed error thrown when the Docker VM cannot be made available. */
export class VmUnavailableError extends Error {
  readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "VmUnavailableError";
    this.cause = cause;
  }
}

/**
 * A docker CLI call exceeded its deadline and was killed (FIX-05). A
 * VmUnavailableError subclass so existing availability handling keeps
 * working, but distinguishable: logs and the UI can say "timed out" (and
 * which command) instead of a generic failure. Retryable: the daemon may
 * answer on the next attempt.
 */
export class DockerTimeoutError extends VmUnavailableError {
  /** The docker subcommand that timed out (e.g. "inspect", "run"). */
  readonly command: string;
  /** The deadline that was exceeded, ms. */
  readonly timeoutMs: number;
  constructor(command: string, timeoutMs: number, signal?: string) {
    super(`docker ${command} timed out after ${timeoutMs}ms${signal ? ` (${signal})` : ""}.`);
    this.name = "DockerTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/** Sanitize a user id into a safe container / volume name segment. */
export function sanitizeId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64) || "user";
}

/**
 * Generate a random VNC password for a desktop container. The driver keeps it
 * server-side only: it is never sent to the browser in clear and never
 * logged. It is seeded as a node-owned pre-start file, never as an argv token
 * or PID 1 environment value. The env override is a deterministic test hook.
 */
export function generateVncPassword(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DESKTOP_VNC_PASSWORD_ENV];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  return randomBytes(12).toString("base64url");
}

/**
 * Docker label recording which user owns a VM container/volume. Every driver
 * resource created by this code carries it, and every attach path verifies it
 * before touching the resource, so a name collision can never cross users.
 */
export const VM_OWNER_LABEL = "swarm.vm.user";
/** Length of the owner fingerprint used in resource names (hex chars). */
export const VM_OWNER_KEY_HEX = 16;
/** Max length of the readable slug prefix of a per-user resource name. */
export const USER_SLUG_MAX = 40;

/**
 * Collision-resistant owner fingerprint for a user id. `sanitizeId` is not
 * injective (`local_a.b@corp.com` and `local_a-b@corp.com` collide), so every
 * per-user resource name appends a prefix of the SHA-256 of the raw user id.
 * The fingerprint alone is unguessable from the readable slug.
 */
export function ownerKeyFor(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, VM_OWNER_KEY_HEX);
}

/**
 * The injective base for a user's resource names:
 * `<readable-slug-max-40>-<first 16 hex of sha256(userId)>`. The slug keeps
 * names readable and bounded; the fingerprint makes the name injective.
 */
export function userResourceBase(userId: string): string {
  const slug = sanitizeId(userId).slice(0, USER_SLUG_MAX) || "user";
  return `${slug}-${ownerKeyFor(userId)}`;
}

/** Build the container name for a user (injective). */
export function containerNameFor(userId: string): string {
  return `swarm-vm-${userResourceBase(userId)}`;
}

/** Build the volume name for a user (injective). */
export function volumeNameFor(userId: string): string {
  return `swarm-vm-${userResourceBase(userId)}-workspace`;
}

/** Repository holding this user's snapshot images (one tag per label; injective). */
export function snapshotRepoFor(userId: string): string {
  return `swarm-vm-${userResourceBase(userId)}-snap`;
}

/**
 * Named volume holding the /workspace backup for one snapshot (one volume
 * per label; injective). `docker commit` never captures mounted volumes, so
 * a snapshot is an image *plus* this volume: the image carries the
 * container's installed state, the volume carries /workspace. The label
 * charset (see {@link validateSnapshotLabel}) is a subset of the volume-name
 * charset, so the name is always valid.
 */
export function snapshotVolumeFor(userId: string, label: string): string {
  return `${snapshotRepoFor(userId)}-${label}`;
}

/**
 * The pre-fix (colliding) names, used only for one-time migration: when a
 * fresh VM is created for a user we check whether a legacy-named container or
 * volume exists and, if it belongs unambiguously to this user, move it to the
 * new injective names. Kept strictly separate from the live names so a legacy
 * name can never be re-used as a live name.
 */
export function legacyContainerNameFor(userId: string): string {
  return `swarm-vm-${sanitizeId(userId)}`;
}

/** The pre-fix volume name for a user (see {@link legacyContainerNameFor}). */
export function legacyVolumeNameFor(userId: string): string {
  return `swarm-vm-${sanitizeId(userId)}-workspace`;
}

/** Environment variable names must be valid POSIX identifiers. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate an environment variable name (throws on anything else). */
export function validateEnvName(name: string): void {
  if (!ENV_NAME_RE.test(name)) {
    throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
  }
}

/**
 * Build the argv for `docker exec`.
 *
 * - `-w <cwd>` replaces any `cd ... &&` prefixing.
 * - `-e NAME` forwards only the name; docker copies the value from the client
 *   env we pass to spawn, so values never appear in argv.
 * - `-i` is used only when stdin data is supplied, so commands that read stdin
 *   don't hang on a pipe we never close.
 * - `--` separates options from the command, so argv can never be parsed as
 *   docker options.
 */
export function buildExecArgs(
  containerName: string,
  cmd: string[],
  opts?: Pick<ExecOptions, "cwd" | "env" | "stdin">,
): string[] {
  const args = ["exec"];
  if (opts?.stdin !== undefined) args.push("-i");
  if (opts?.cwd) args.push("-w", opts.cwd);
  if (opts?.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) continue;
      validateEnvName(key);
      args.push("-e", key);
    }
  }
  args.push("--", containerName, ...cmd); // "--" before the name: docker stops flag parsing at the container, so a "--" after it would become the command.
  return args;
}

/** Directory holding one pgid file per in-flight exec (inside the VM). */
export const EXEC_PGID_DIR = "/tmp";
/** Prefix of the per-exec process-group marker file. */
export const EXEC_PGID_PREFIX = `${EXEC_PGID_DIR}/.swarm-exec-`;

/** Unique process-group marker path for one exec. */
export function execPgidPath(id: string): string {
  return `${EXEC_PGID_PREFIX}${id}.pgid`;
}

/**
 * Shell wrapper that runs a command in its own session / process group and
 * records that group's id in `$1` (the marker file), so an abort can kill only
 * this exec without touching concurrent execs in the same container.
 *
 * `setsid -w` makes the inner shell a session leader (so its pid *is* its
 * pgid) and waits for it, preserving the exit status. The file is removed on
 * normal completion; the abort cleanup removes it after using it.
 */
export const EXEC_PGID_WRAPPER =
  'pgid="$1"; shift; ' +
  "setsid -w sh -c 'echo $$ > \"$0\"; exec \"$@\"' \"$pgid\" \"$@\"; " +
  'status=$?; rm -f "$pgid"; exit "$status"';

/** The command to run inside the container for a tracked exec. */
export function buildTrackedCommand(pgidFile: string, cmd: string[]): string[] {
  return ["sh", "-c", EXEC_PGID_WRAPPER, "sh", pgidFile, ...cmd];
}

/**
 * A caller-supplied pgid marker path is honored only inside the exec
 * scratch dir (`/tmp/.swarm-exec-*.pgid`); anything else falls back to a
 * random marker so a bad path can never redirect the kill at another file.
 */
export function validPgidFile(pgidFile: string | undefined): string | undefined {
  if (!pgidFile) return undefined;
  return /^\/tmp\/\.swarm-exec-[A-Za-z0-9_.-]+\.pgid$/.test(pgidFile) ? pgidFile : undefined;
}

/**
 * In-container argv that SIGKILLs the process group recorded in a pgid
 * marker file, then removes the marker. A no-op when the file is gone (the
 * group already died, or the exec never started). This is the run manager's
 * cancel backstop: it names exactly one recorded group and must never be
 * pointed at PID 1 or any other group.
 */
export function buildPgidKillCommand(pgidFile: string): string[] {
  return [
    "sh",
    "-c",
    // NOTE: no `--` before the negative pid: dash's kill builtin (the
    // container's /bin/sh) rejects `--` when the signal is given as
    // `-SIGNAME` (rc 2, group survives). The bare "-$pgid" operand is the
    // POSIX process-group form and works. (With `-s NAME` the rule flips:
    // `--` is required; see buildExecKillArgs.)
    'pgid="$(cat "$1" 2>/dev/null)"; if [ -n "$pgid" ]; then kill -KILL "-$pgid" 2>/dev/null || true; fi; rm -f "$1"',
    "sh",
    pgidFile,
  ];
}

/**
 * Args for the best-effort cleanup of one aborted exec: signal only the
 * process group recorded for *that* exec (never every child of pid 1), then
 * drop the marker file.
 */
export function buildExecKillArgs(containerName: string, pgidFile: string): string[] {
  return buildExecArgs(containerName, [
    "sh",
    "-c",
    // The marker is written just after the exec starts; give it a short
    // window so an abort racing the spawn still finds the group.
    'pgid=""; i=0; while [ -z "$pgid" ] && [ "$i" -lt 10 ]; do ' +
      'pgid="$(cat "$1" 2>/dev/null)"; [ -n "$pgid" ] && break; ' +
      "i=$((i+1)); sleep 0.05; done; " +
      // dash's kill builtin needs `--` before a negative pid when the signal
      // is given as `-s NAME` (without it the -NNN is parsed as an option
      // and the kill fails) — but rejects `--` when the signal is given as
      // `-SIGNAME`. Keep the two forms distinct; see buildPgidKillCommand.
      'if [ -n "$pgid" ]; then kill -s TERM -- "-$pgid" 2>/dev/null || true; fi; ' +
      'rm -f "$1"',
    "sh",
    pgidFile,
  ]);
}

/**
 * Docker's "resource does not exist" messages. `rm -f` / `volume rm -f` may
 * report one of these for an already-gone resource; for reset that is success.
 */
export function isNotFoundError(stderr: string): boolean {
  return /no such (?:container|volume|object)/i.test(stderr);
}

/**
 * Build the args for `docker run -d` with a hardened security profile:
 * a hard memory / CPU / PID ceiling, no new privileges, all capabilities
 * dropped except a minimal dev-box set, and a bundled init so zombie
 * processes get reaped.
 *
 * The limits are validated first: a malformed value must never reach the
 * docker CLI (where it would either be ignored or fail the whole run).
 */
/**
 * Parse `docker port <container> 6080` stdout into a loopback host port.
 * Prefers explicit `127.0.0.1:<port>` bindings over wildcard bindings.
 */
export function parseDockerPublishedPort(stdout: string): number | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  lines.sort((a, b) => {
    const aLoop = a.startsWith("127.0.0.1:") ? 0 : 1;
    const bLoop = b.startsWith("127.0.0.1:") ? 0 : 1;
    return aLoop - bLoop;
  });
  for (const line of lines) {
    const match = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::\]):(\d+)$/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return null;
}

export function buildRunArgs(opts: {
  containerName: string;
  volume: string;
  image: string;
  memory: string;
  cpus: string;
  pidsLimit: string;
  /** OCI runtime; validated against the allowlist (unset/blank -> no flag). */
  runtime?: string;
  /** Docker network to attach the container to (unset/blank -> no flag). */
  network?: string;
  /**
   * Desktop mode: size /dev/shm for a browser (e.g. "1g"), forward env
   * values by name only (the values travel in the spawn env, never argv),
   * and omit the `tail -f /dev/null` override so the image's own CMD
   * (desktop init + supervisord) runs. No ports are ever published unless
   * `publishDesktopPort` is explicitly enabled for macOS/Colima local dev.
   */
  desktop?: boolean;
  /** Bind VNC port 6080 to an ephemeral loopback port (`-p 127.0.0.1::6080`). */
  publishDesktopPort?: boolean;
  shmSize?: string;
  env?: Record<string, string>;
  /** Docker labels to stamp on the created container (e.g. the owner label). */
  labels?: Record<string, string>;
  /**
   * Create the container without starting it (`docker create`). Desktop mode
   * uses this so the VNC password can be copied in as a 0600 file before the
   * container's PID 1 ever starts — the secret never enters its environment.
   */
  create?: boolean;
}): string[] {
  const memory = validateMemoryLimit(opts.memory, "memory");
  const cpus = validateCpuLimit(opts.cpus, "cpus");
  const pids = validatePidsLimit(opts.pidsLimit, "pids");
  const runtime =
    opts.runtime !== undefined && opts.runtime.trim() !== ""
      ? validateVmRuntime(opts.runtime, "runtime")
      : undefined;
  const network =
    opts.network !== undefined && opts.network.trim() !== ""
      ? validateVmNetwork(opts.network, "network")
      : undefined;
  const args = [
    ...(opts.create ? ["create"] : ["run", "-d"]),
    "--name", opts.containerName,
    "--memory", memory,
    "--cpus", cpus,
    "--pids-limit", pids,
  ];
  if (runtime) args.push("--runtime", runtime);
  if (network) args.push("--network", network);
  if (opts.shmSize) args.push("--shm-size", opts.shmSize);
  if (opts.desktop && opts.publishDesktopPort) {
    args.push("-p", `127.0.0.1::${DESKTOP_VNC_PORT}`);
  }
  if (opts.env) {
    for (const name of Object.keys(opts.env)) {
      validateEnvName(name);
      args.push("-e", name);
    }
  }
  if (opts.labels) {
    for (const [key, value] of Object.entries(opts.labels)) {
      args.push("--label", `${key}=${value}`);
    }
  }
  args.push(
    "--restart", "unless-stopped",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    ...VM_CAPABILITIES.flatMap((cap) => ["--cap-add", cap]),
    "--init",
    "-v", `${opts.volume}:/workspace`,
    "-w", "/workspace",
    opts.image,
  );
  // A desktop container runs the image's own CMD (desktop init -> supervisor);
  // a headless container is driven purely through `docker exec`, so it gets
  // the long-lived `tail` placeholder as before.
  if (!opts.desktop) {
    args.push("tail", "-f", "/dev/null");
  }
  return args;
}

/**
 * Build the args for `docker update`, used to (re-)apply the resource
 * limits to a container that already exists — a VM created before the
 * limits were configured must not keep running unbounded.
 */
export function buildUpdateArgs(opts: {
  containerName: string;
  memory: string;
  cpus: string;
  pidsLimit: string;
}): string[] {
  return [
    "update",
    "--memory", validateMemoryLimit(opts.memory, "memory"),
    "--cpus", validateCpuLimit(opts.cpus, "cpus"),
    "--pids-limit", validatePidsLimit(opts.pidsLimit, "pids"),
    opts.containerName,
  ];
}

/**
 * Wrap a command in GNU `timeout` so the in-container process is killed when
 * the deadline passes. `timeout` exits with 124 on its own trigger, which is
 * exactly the exit code we promise for a timed-out exec.
 */
export function buildTimeoutWrap(cmd: string[], timeoutMs: number): string[] {
  const secs = Math.max(timeoutMs, 100) / 1000;
  return ["timeout", "-s", "TERM", "--kill-after=2s", `${secs.toFixed(3)}s`, ...cmd];
}

/** Map a `stat -c %F` kind to our entry type. */
function statType(kind: string | undefined): VmFileStat["type"] {
  const k = (kind ?? "").toLowerCase();
  if (k.includes("directory")) return "directory";
  if (k.includes("file")) return "file";
  return "other";
}

/** Map a `find -printf %y` kind to our entry type. */
function entryType(kind: string | undefined): VmDirEntry["type"] {
  if (kind === "f") return "file";
  if (kind === "d") return "directory";
  return "other";
}

/** Docker image reference charset for snapshot names (name[:tag][@digest]). */
const SNAPSHOT_NAME_RE = new RegExp(
  "^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*" +
  "(?::[a-zA-Z0-9_][a-zA-Z0-9._-]*)?" +
  "(?:@sha256:[0-9a-f]{64})?$",
);

/** Validate a snapshot name against the docker image reference charset. */
export function validateSnapshotName(name: string): void {
  if (!SNAPSHOT_NAME_RE.test(name)) {
    throw new Error(`Invalid snapshot name: ${JSON.stringify(name)}`);
  }
}

/**
 * Snapshot labels become a docker image tag, so keep them to the conservative
 * tag charset: 1-64 chars, lowercase alphanumerics plus `.`, `_` and `-`,
 * starting with an alphanumeric, and no `..` (which docker rejects).
 */
const SNAPSHOT_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Validate a user-supplied snapshot label (throws on anything unsafe). */
export function validateSnapshotLabel(label: string): void {
  if (!SNAPSHOT_LABEL_RE.test(label) || label.includes("..")) {
    throw new Error(`Invalid snapshot label: ${JSON.stringify(label)}`);
  }
}

export interface DockerVmDriverOptions {
  image?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  /** OCI runtime for the container (e.g. "runsc"); allowlist-validated. */
  runtime?: string;
  /** Docker network the container is attached to (e.g. "swarm-vms"). */
  network?: string;
  /**
   * Desktop mode (defaults to SWARM_VM_DESKTOP=1). Picks the desktop image,
   * sizes /dev/shm, forwards DISPLAY + a generated VNC password, and exposes
   * desktopEndpoint().
   */
  desktop?: boolean;
  /** Bind desktop VNC 6080 onto 127.0.0.1:<ephemeral> (macOS Colima bridge). */
  localPublish?: boolean;
  /** How long to wait after the JS timeout deadline before killing the docker CLI. */
  killGraceMs?: number;
  /**
   * Per-class docker CLI deadlines (FIX-05). Overrides the
   * SWARM_VM_DOCKER_*_TIMEOUT_MS env defaults per class; an explicit
   * `timeoutMs` at a call site still wins over both.
   */
  dockerTimeouts?: Partial<Record<DockerTimeoutClass, number>>;
  /**
   * Cap on stdout buffered per docker CLI call (default
   * {@link MAX_RUN_STDOUT_BYTES}); a per-call `maxStdoutBytes` still wins.
   */
  maxRunStdoutBytes?: number;
  /** Cap on stderr retained per docker CLI call (default {@link MAX_RUN_STDERR_BYTES}). */
  maxRunStderrBytes?: number;
  /** Injectable spawn for tests (defaults to node:child_process spawn). */
  spawnFn?: DockerSpawnFn;
  /**
   * Provider of the known user ids, used to decide whether a legacy-named VM
   * resource belongs to a single owner (safe to migrate) or to several
   * (ambiguous — leave it alone). Defaults to all local accounts plus the
   * harness user.
   */
  legacyOwnerCandidates?: () => string[];
}

/** Default known-user provider: every local account plus the harness user. */
function defaultLegacyOwnerCandidates(): string[] {
  try {
    return [...listLocalUserIds(), "harness"];
  } catch {
    // A missing/unreadable user store must not break VM creation.
    return ["harness"];
  }
}

/** DockerVmDriver — one container per user, named volume for /workspace persistence. */
export class DockerVmDriver implements VmDriver {
  readonly image: string;
  readonly memory: string;
  readonly cpus: string;
  readonly pidsLimit: string;
  /** Effective OCI runtime; undefined means Docker's default (no flag). */
  readonly runtime: string | undefined;
  /** Effective docker network; undefined means Docker's default (no flag). */
  readonly network: string | undefined;
  /** Desktop mode: true when the VM gets a desktop + VNC endpoint. */
  readonly desktop: boolean;
  /** Bind desktop VNC to 127.0.0.1:<ephemeral> when Docker runs inside a host VM (macOS Colima). */
  readonly localPublish: boolean;
  private readonly killGraceMs: number;
  /** Resolved per-class docker CLI deadlines (constructor > env > built-in). */
  private readonly dockerTimeouts: Record<DockerTimeoutClass, number>;
  /** Cap on stdout buffered per docker CLI call. */
  private readonly maxRunStdoutBytes: number;
  /** Cap on stderr retained per docker CLI call. */
  private readonly maxRunStderrBytes: number;
  private readonly spawnFn: DockerSpawnFn;
  /**
   * Per-user VNC passwords generated for desktop containers in this process.
   * For containers that already exist the password is read back from the
   * container's own file, so a server restart does not lose the endpoint.
   */
  private readonly desktopPasswords = new Map<string, string>();
  /** Known-user provider used by the legacy-naming migration. */
  private readonly legacyOwnerCandidates: () => string[];

  constructor(opts: DockerVmDriverOptions = {}) {
    this.desktop = opts.desktop ?? (process.env.SWARM_VM_DESKTOP === "1" || SWARM_VM_DESKTOP);
    this.localPublish =
      opts.localPublish ?? (process.env.SWARM_VM_LOCAL_PUBLISH === "1" || SWARM_VM_LOCAL_PUBLISH);
    // Desktop mode picks the desktop image by default; under the hood it is
    // still just the image the user configures (env wins, explicit option
    // wins over env).
    const envDesktopImg = (process.env.SWARM_VM_DESKTOP_IMAGE ?? "").trim() || SWARM_VM_DESKTOP_IMAGE;
    const envBaseImg = process.env.SWARM_VM_IMAGE ?? SWARM_VM_IMAGE;
    this.image = opts.image ?? (this.desktop ? envDesktopImg : envBaseImg);
    // Explicit options win over env, env wins over the defaults. An invalid
    // value throws a VmLimitError here rather than reaching the docker CLI.
    // Desktop mode keeps the standard 2g default ceiling (never lower), but
    // an explicit SWARM_VM_MEMORY (or constructor option) still wins.
    const limits = resolveVmLimits(
      process.env,
      {
        memory: opts.memory,
        cpus: opts.cpus,
        pids: opts.pidsLimit,
      },
      this.desktop ? { memory: DEFAULT_VM_DESKTOP_MEMORY } : undefined,
    );
    this.memory = limits.memory;
    this.cpus = limits.cpus;
    this.pidsLimit = limits.pids;
    this.runtime = resolveVmRuntime(process.env, opts.runtime);
    this.network = resolveVmNetwork(process.env, opts.network);
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.dockerTimeouts = { ...DEFAULT_DOCKER_TIMEOUTS, ...(opts.dockerTimeouts ?? {}) };
    this.maxRunStdoutBytes =
      opts.maxRunStdoutBytes && opts.maxRunStdoutBytes > 0 ? opts.maxRunStdoutBytes : MAX_RUN_STDOUT_BYTES;
    this.maxRunStderrBytes =
      opts.maxRunStderrBytes && opts.maxRunStderrBytes > 0 ? opts.maxRunStderrBytes : MAX_RUN_STDERR_BYTES;
    // Node's spawn is overloaded; pin it to our single signature.
    this.spawnFn = opts.spawnFn ?? (spawn as unknown as DockerSpawnFn);
    this.legacyOwnerCandidates = opts.legacyOwnerCandidates ?? defaultLegacyOwnerCandidates;
  }

  /** Spawn a process with argv array, return { code, stdout, stderr }. */
  private async run(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; stdin?: string | Buffer; maxStdoutBytes?: number; maxStderrBytes?: number }): Promise<{ code: number; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }> {
    const raw = await this.runRaw(args, opts);
    return {
      code: raw.code,
      stdout: raw.stdout.toString("utf8"),
      stderr: raw.stderr,
      stdoutTruncated: raw.stdoutTruncated,
      stderrTruncated: raw.stderrTruncated,
    };
  }

  /** Same as run() but keeps stdout as raw bytes (binary-safe). */
  private async runRaw(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; stdin?: string | Buffer; maxStdoutBytes?: number; maxStderrBytes?: number }): Promise<{ code: number; stdout: Buffer; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }> {
    // Every docker CLI call is deadline-bound (FIX-05): an explicit
    // timeoutMs wins; otherwise the per-class default applies, so a wedged
    // daemon fails the call with a typed timeout instead of holding the
    // caller's per-user lock forever.
    const timeoutMs =
      opts?.timeoutMs && opts.timeoutMs > 0
        ? opts.timeoutMs
        : this.dockerTimeouts[dockerTimeoutClassFor(args)];
    return new Promise((resolve, reject) => {
      const cp = this.spawnFn("docker", args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...(opts?.env ?? {}) },
        // argv arrays are safe; no shell injection risk.
        shell: false,
      });

      let settled = false;
      let t: ReturnType<typeof setTimeout> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const clearTimers = () => {
        if (t) clearTimeout(t);
        if (killTimer) clearTimeout(killTimer);
        t = null;
        killTimer = null;
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimers();
        const errno = err as NodeJS.ErrnoException;
        if (errno?.code === "ENOENT") {
          reject(
            new VmUnavailableError(
              "Docker CLI was not found (ENOENT). Ensure Docker is installed and available on your PATH.",
              errno,
            ),
          );
        } else {
          reject(err);
        }
      };

      const maxStdoutBytes =
        opts?.maxStdoutBytes && opts.maxStdoutBytes > 0 ? opts.maxStdoutBytes : this.maxRunStdoutBytes;
      const maxStderrBytes =
        opts?.maxStderrBytes && opts.maxStderrBytes > 0 ? opts.maxStderrBytes : this.maxRunStderrBytes;
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutTruncated = false;
      // stderr keeps only the tail (the actionable part of a failure), held
      // as chunks behind a head index so trimming stays O(1) amortized.
      const stderrChunks: Buffer[] = [];
      let stderrHead = 0;
      let stderrBytes = 0;
      let stderrTruncated = false;
      let killedByTimeout = false;
      // SIGTERM first; a CLI that ignores it gets SIGKILL after the grace
      // period, so no zombie docker client outlives its deadline or abort.
      const terminate = () => {
        try { cp.kill("SIGTERM"); } catch { /* ignore */ }
        if (!killTimer) {
          killTimer = setTimeout(() => {
            try { cp.kill("SIGKILL"); } catch { /* ignore */ }
          }, this.killGraceMs);
          killTimer.unref?.();
        }
      };
      cp.stdout?.on("data", (buf) => {
        const chunk = Buffer.from(buf as Buffer);
        if (stdoutTruncated) return; // keep draining, discard past the cap
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          stdoutTruncated = true;
          const keep = chunk.length - (stdoutBytes - maxStdoutBytes);
          if (keep > 0) chunks.push(chunk.subarray(0, keep));
          return;
        }
        chunks.push(chunk);
      });
      cp.stderr?.on("data", (buf) => {
        const chunk = Buffer.from(buf as Buffer);
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        while (stderrBytes > maxStderrBytes && stderrHead < stderrChunks.length) {
          stderrTruncated = true;
          const head = stderrChunks[stderrHead]!;
          const excess = stderrBytes - maxStderrBytes;
          if (head.length <= excess) {
            stderrBytes -= head.length;
            stderrHead++;
          } else {
            stderrChunks[stderrHead] = head.subarray(excess);
            stderrBytes -= excess;
          }
        }
        // Release dropped chunks so a spewing stderr cannot pin them.
        if (stderrHead >= 1024) {
          stderrChunks.splice(0, stderrHead);
          stderrHead = 0;
        }
      });
      // A broken output pipe must settle this call, never escape unhandled.
      watchChildStream(cp.stdout, (err) => fail(vmStreamError("stdout", err)));
      watchChildStream(cp.stderr, (err) => fail(vmStreamError("stderr", err)));

      if (opts?.stdin !== undefined) {
        if (!cp.stdin) {
          fail(new Error(`docker ${args[0] ?? "command"} requires stdin, but the child has no stdin stream.`));
        } else {
          writeChildStdin(cp.stdin, opts.stdin, fail);
        }
      }

      if (opts?.signal) {
        const onAbort = () => terminate();
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      t = setTimeout(() => {
        killedByTimeout = true;
        terminate();
      }, timeoutMs);
      t.unref?.();

      cp.on("error", fail);

      cp.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimers();
        // We killed this CLI for exceeding its deadline: report the timeout
        // (typed, with the command) whatever exit the kill produced.
        if (killedByTimeout) {
          reject(new DockerTimeoutError(args[0] ?? "command", timeoutMs, signal ?? undefined));
          return;
        }
        // A null exit code means the docker CLI itself was killed by a
        // signal. Never report that as success: a pull/run/rm that died to a
        // timeout must surface the real cause (and its signal), not a later
        // misleading "Unable to find image" from the following call.
        if (code === null) {
          const sig = signal ?? "unknown signal";
          reject(
            new VmUnavailableError(
              `docker ${args[0] ?? "command"} was terminated by a signal (${sig}).`,
            ),
          );
          return;
        }
        resolve({
          code,
          stdout: Buffer.concat(chunks),
          stderr: Buffer.concat(stderrChunks.slice(stderrHead)).toString("utf8"),
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  }

  /** Create the named volume if it doesn't exist, stamping it with labels. */
  private async ensureVolume(vol: string, labels?: Record<string, string>): Promise<void> {
    const ls = await this.run(["volume", "ls", "-q", "-f", `name=${vol}`]);
    if (!ls.stdout.trim()) {
      const createArgs = ["volume", "create"];
      if (labels) {
        for (const [key, value] of Object.entries(labels)) {
          createArgs.push("--label", `${key}=${value}`);
        }
      }
      createArgs.push(vol);
      const create = await this.run(createArgs);
      if (create.code !== 0) {
        throw new Error(`Failed to create volume ${vol}: ${create.stderr}`);
      }
    }
  }

  /**
   * Read a container's Docker labels (empty map on any failure). Used to
   * verify ownership before attaching to an existing VM.
   */
  private async readContainerLabels(name: string): Promise<Record<string, string>> {
    const res = await this.run(["container", "inspect", "-f", "{{json .Config.Labels}}", name]);
    return this.parseLabels(res.code === 0 ? res.stdout : "");
  }

  /** Parse a `{{json ...}}` field into a label map (never throws). */
  private parseLabels(text: string): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(text.trim());
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    } catch {
      /* not JSON — treat as no labels */
    }
    return {};
  }

  /** True when the container's labels mark it as owned by `userId`. */
  private ownerMatch(labels: Record<string, string>, userId: string): boolean {
    return labels[VM_OWNER_LABEL] === ownerKeyFor(userId);
  }

  /** Log a refused-attach audit event (never throws). */
  private auditDenied(userId: string, name: string): void {
    recordAudit({ user: userId, action: "vm.access.denied", target: name, result: "failure" });
  }

  /**
   * Refuse to attach to a container that is not owned by `userId`. Logs an
   * audit event and throws a {@link VmUnavailableError}. This is the backstop
   * for the name-collision fix: even if a name ever collides, ownership is
   * verified before the resource is touched.
   */
  private async requireOwnership(name: string, userId: string): Promise<void> {
    if (!this.ownerMatch(await this.readContainerLabels(name), userId)) {
      this.auditDenied(userId, name);
      throw new VmUnavailableError(
        `Container ${name} is owned by another user or lacks an owner label; ` +
          `refusing to attach.`,
      );
    }
  }

  /**
   * One-time migration of a pre-fix (colliding) VM resource onto the injective
   * names. Returns true when a legacy container/volume existed AND was claimed
   * for `userId`; false when nothing existed, or the legacy resource belonged
   * to another user / was ambiguous — the caller then leaves it untouched and
   * creates a fresh VM under the new names.
   */
  private async migrateLegacyContainer(userId: string, newName: string, newVol: string): Promise<boolean> {
    const legacyName = legacyContainerNameFor(userId);
    const legacyVol = legacyVolumeNameFor(userId);

    const cInspect = await this.run(["container", "inspect", "-f", "{{.State.Status}}", legacyName]);
    const hasContainer = cInspect.code === 0;
    const vLs = await this.run(["volume", "ls", "-q", "-f", `name=${legacyVol}`]);
    const hasVolume = vLs.stdout.trim().length > 0;
    if (!hasContainer && !hasVolume) return false;

    // Claim the legacy resource only when it belongs unambiguously to THIS
    // user (exactly one known account maps to the legacy name, and it is the
    // caller). Ambiguous names — or names owned by someone else — are left in
    // place: attaching would re-create the collision the fix removes.
    const owners = this.legacyOwnerCandidates().filter((id) => legacyContainerNameFor(id) === legacyName);
    if (owners.length !== 1 || owners[0] !== userId) {
      recordAudit({ user: userId, action: "vm.migrate", target: legacyName, result: "failure" });
      return false;
    }

    const key = ownerKeyFor(userId);

    if (hasContainer) {
      const ren = await this.run(["container", "rename", legacyName, newName]);
      if (ren.code !== 0) {
        recordAudit({ user: userId, action: "vm.migrate", target: legacyName, result: "failure" });
        return false;
      }
      const relabel = await this.run(
        ["container", "update", "--label-add", `${VM_OWNER_LABEL}=${key}`, newName],
      );
      if (relabel.code !== 0) {
        // Roll back the rename so the legacy state stays consistent; the
        // caller then creates a fresh VM instead of leaving a stranded ownerless
        // container under our new name.
        await this.run(["container", "rename", newName, legacyName]);
        recordAudit({ user: userId, action: "vm.migrate", target: legacyName, result: "failure" });
        return false;
      }
    }

    if (hasVolume && legacyVol !== newVol) {
      await this.ensureVolume(newVol, { [VM_OWNER_LABEL]: key });
      const cp = await this.run([
        "run", "--rm",
        // Same reason as copyVolume: the fresh destination volume is root-owned.
        "-u", "0:0",
        "-v", `${legacyVol}:/src`,
        "-v", `${newVol}:/dst`,
        this.image,
        "sh", "-c", "cp -a /src/. /dst/",
      ]);
      if (cp.code !== 0) {
        recordAudit({ user: userId, action: "vm.migrate", target: legacyVol, result: "failure" });
        return false;
      }
      await this.run(["volume", "rm", legacyVol]);
    }

    // Retag any legacy snapshot images into the new repo (best-effort).
    const legacyRepo = `swarm-vm-${sanitizeId(userId)}-snap`;
    const newRepo = snapshotRepoFor(userId);
    if (legacyRepo !== newRepo) {
      const img = await this.run(
        ["images", "--filter", `reference=${legacyRepo}`, "--format", "{{.Repository}}:{{.Tag}}"],
      );
      for (const line of img.stdout.split("\n")) {
        const ref = line.trim();
        if (!ref) continue;
        const tag = ref.slice(ref.lastIndexOf(":") + 1);
        await this.run(["tag", ref, `${newRepo}:${tag}`]);
        await this.run(["rmi", ref]);
      }
    }

    recordAudit({ user: userId, action: "vm.migrate", target: legacyName, result: "success" });
    return true;
  }

  /**
   * (Re-)apply the resource limits to an existing container. Containers
   * created before the limits were configured keep running unbounded, so
   * every ensure() re-applies them. Best-effort: an old daemon without
   * cgroup-pids support must not make the VM unusable, but the operator
   * should know that the limits are not in effect.
   */
  private async applyLimits(containerName: string): Promise<void> {
    const res = await this.run(
      buildUpdateArgs({
        containerName,
        memory: this.memory,
        cpus: this.cpus,
        pidsLimit: this.pidsLimit,
      }),
    );
    if (res.code !== 0) {
      console.error(
        `[vm] could not apply resource limits to ${containerName}: ` +
          `${res.stderr.trim() || `exit code ${res.code}`}`,
      );
    }
  }

  /**
   * True when an existing container was created from a different image than
   * the one this driver would use now. Only consulted in desktop mode; the
   * headless path keeps reattaching whatever container exists (old behavior).
   */
  private async desktopImageMismatch(containerName: string): Promise<boolean> {
    const res = await this.run(["container", "inspect", "-f", "{{.Config.Image}}", containerName]);
    if (res.code !== 0) return false;
    const image = res.stdout.trim();
    if (!image) return false;
    if (image === this.image) return false;
    // `docker run` normalizes some refs; treat a resolved-identical image as
    // a match via the image id rather than the literal ref.
    const refImage = await this.run(["image", "inspect", "-f", "{{.Id}}", image]);
    const wantImage = await this.run(["image", "inspect", "-f", "{{.Id}}", this.image]);
    if (refImage.code === 0 && wantImage.code === 0) {
      return refImage.stdout.trim() !== wantImage.stdout.trim();
    }
    return true;
  }

  /**
   * Read the VNC password the container's init script stored for the driver
   * (plaintext copy kept server-side inside the container, 0600). Returns
   * undefined when the file is not there — e.g. a non-desktop container.
   */
  private async readDesktopPassword(containerName: string): Promise<string | undefined> {
    const res = await this.run(["exec", containerName, "cat", "--", DESKTOP_VNC_PASSWORD_FILE]);
    if (res.code !== 0) return undefined;
    const password = res.stdout.trim();
    return password || undefined;
  }

  /**
   * Copy the generated VNC password into a created-but-not-yet-started
   * desktop container as a 0600, node-owned file. The init script reads it at
   * start, so the password never appears in the container's environment (and
   * therefore never in /proc/1/environ). The host temp copy is removed
   * immediately after the copy.
   */
  /**
   * The tar flags that stamp the seeded VNC password file as node-owned
   * (uid/gid 1000). BSD tar (macOS) and GNU tar (Linux) spell ownership
   * differently, and GNU tar 1.35 rejects the BSD spellings outright
   * (`tar: unrecognized option '--uid'`), which broke desktop mode on every
   * Linux Docker host. `--no-xattrs` is BSD-only too: it exists to keep
   * macOS-only metadata out of the archive, and GNU tar never writes any,
   * so the Linux spelling simply omits it.
   *
   * Exported (and parameterised by platform) so tests can assert both
   * spellings without depending on the host they run on.
   */
  private async seedDesktopPassword(containerName: string, password: string): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "swarm-vnc-"));
    try {
      const entryName = path.basename(DESKTOP_VNC_PASSWORD_FILE);
      const file = path.join(dir, entryName);
      await writeFile(file, `${password}\n`, { mode: 0o600 });
      // docker cp has no portable --chown flag. Stream a tar archive with
      // numeric node ownership instead, preserving the 0600 temp-file mode.
      const tarball = execFileSync(
        "tar",
        ["-cf", "-", ...desktopVncTarArgs(), "-C", dir, entryName],
        // One tiny file; bound it anyway so a wedged tar cannot hang ensure().
        { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" },
      );
      const res = await this.run(
        ["cp", "-", `${containerName}:/home/node/.vnc/`],
        { stdin: tarball },
      );
      if (res.code !== 0) {
        throw new VmUnavailableError(
          `Failed to seed the VNC password into ${containerName}: ` +
            `${res.stderr.trim() || `exit code ${res.code}`}`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Start a created container, seeding the VNC password first when needed. */
  private async startCreated(
    containerName: string,
    password: string | undefined,
  ): Promise<void> {
    if (password) await this.seedDesktopPassword(containerName, password);
    const started = await this.run(["start", containerName]);
    if (started.code !== 0) {
      throw new VmUnavailableError(
        `Failed to start container ${containerName}: ` +
          `${started.stderr.trim() || `exit code ${started.code}`}`,
      );
    }
  }

  /**
   * The VM container's IP on its docker network, or null when the container
   * does not exist / is not running / has no IP / belongs to another user.
   * The preview proxy dials this host directly — the same mechanism
   * desktopEndpoint() uses for the VNC port, minus the desktop-mode gate:
   * preview tunnels work in headless mode too. The port is never published
   * to the host; only the app server (on the docker network) can reach it.
   */
  async containerIp(handle: VmHandle): Promise<string | null> {
    const name = containerNameFor(handle.userId);
    const inspect = await this.run([
      "container",
      "inspect",
      "-f",
      "{{.State.Status}}\t{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}\t{{json .Config.Labels}}",
      name,
    ]);
    if (inspect.code !== 0) return null;
    const [status, ips, labelsText] = inspect.stdout.trim().split("\t");
    // A container may be on several networks; use the first IP returned.
    const ip = ips?.split(/\s+/).find((entry) => entry.length > 0);
    if (status !== "running" || !ip) return null;
    // Never expose another user's VM: a container whose owner label does not
    // match the caller is refused and logged.
    if (!this.ownerMatch(this.parseLabels(labelsText ?? ""), handle.userId)) {
      this.auditDenied(handle.userId, name);
      return null;
    }
    return ip;
  }

  /**
   * The browser-viewable desktop endpoint for a user's VM, or null when
   * desktop mode is off, the container does not exist / is not running, or
   * the VNC password cannot be recovered.
   */
  async desktopEndpoint(handle: VmHandle): Promise<VmDesktopEndpoint | null> {
    if (!this.desktop) return null;
    const ip = await this.containerIp(handle);
    if (!ip) return null;

    let password = this.desktopPasswords.get(handle.userId);
    if (!password) {
      password = (await this.readDesktopPassword(containerNameFor(handle.userId))) ?? "";
      if (password) this.desktopPasswords.set(handle.userId, password);
    }
    if (!password) return null;

    if (this.localPublish) {
      const portRes = await this.run(["port", handle.containerName, String(DESKTOP_VNC_PORT)]);
      if (portRes.code === 0) {
        const hostPort = parseDockerPublishedPort(portRes.stdout);
        if (hostPort) return { host: "127.0.0.1", port: hostPort, password };
      }
    }

    return { host: ip, port: DESKTOP_VNC_PORT, password };
  }

  /** Inspect a container for its state status and Docker labels in one call. */
  private async inspectStatusLabels(
    name: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.run(["container", "inspect", "-f", "{{.State.Status}}\t{{json .Config.Labels}}", name]);
  }

  async ensure(userId: string): Promise<VmHandle> {
    const name = containerNameFor(userId);
    const vol = volumeNameFor(userId);
    const key = ownerKeyFor(userId);

    await this.ensureVolume(vol, { [VM_OWNER_LABEL]: key });

    // Check if the (injective-named) container already exists. When it does
    // not, try to migrate a legacy-named resource that unambiguously belongs
    // to this user before creating a fresh VM.
    let inspect = await this.inspectStatusLabels(name);
    if (inspect.code !== 0 && (await this.migrateLegacyContainer(userId, name, vol))) {
      inspect = await this.inspectStatusLabels(name);
    }

    let stateStatus = "";
    if (inspect.code === 0) {
      const [s, labelsText] = inspect.stdout.trim().split("\t");
      stateStatus = s ?? "";
      // Gate: never attach to a container owned by another user (or one
      // carrying no owner label). This is the backstop for the name-collision
      // fix.
      if (!this.ownerMatch(this.parseLabels(labelsText ?? ""), userId)) {
        this.auditDenied(userId, name);
        throw new VmUnavailableError(
          `Container ${name} is owned by another user or lacks an owner label; ` +
            `refusing to attach.`,
        );
      }
    }

    // In desktop mode an existing container must actually be a desktop
    // container: a container left over from an earlier headless image has no
    // desktop services, so it is recreated from the desktop image (the
    // /workspace volume survives).
    const recreate = inspect.code === 0 && this.desktop && (await this.desktopImageMismatch(name));

    if (inspect.code !== 0 || recreate) {
      // Container does not exist — ensure the image is available first.
      const imageInspect = await this.run(["image", "inspect", "-f", "{{.Id}}", this.image]);
      if (imageInspect.code !== 0) {
        // Image is missing locally.
        if (process.env.SWARM_VM_PULL === "1") {
          const pull = await this.run(["pull", this.image], {
            timeoutMs: SWARM_VM_PULL_TIMEOUT_MS,
          });
          if (pull.code !== 0) {
            throw new VmUnavailableError(
              `Docker image "${this.image}" is not available locally and could not be pulled. ` +
                `Ensure the image name is correct and Docker has registry access. ` +
                `Pull stderr: ${pull.stderr.trim() || "(no output)"}`,
            );
          }
        } else {
          throw new VmUnavailableError(
            `Docker image "${this.image}" is not available locally. ` +
              `Set SWARM_VM_PULL=1 to auto-pull, or pull it manually with: docker pull ${this.image}`,
          );
        }
      }

      // When a non-default runtime is configured, verify the daemon actually
      // has it before creating the container. Silently falling back to the
      // default runtime would drop the isolation the operator asked for.
      if (this.runtime) {
        const info = await this.run(["info", "--format", "{{json .Runtimes}}"]);
        if (info.code === 0) {
          // `docker info` renders Runtimes either as JSON
          // (`{"runsc":{"Path":"/usr/bin/runsc","Args":null},"runc":{}}`)
          // or, on older daemons, as a Go map (`map[runsc:{...} runc:{}]`).
          // Parse both into the set of registered runtime names.
          let registered: string[] = [];
          try {
            registered = Object.keys(JSON.parse(info.stdout.trim()) as Record<string, unknown>);
          } catch {
            registered = Array.from(
              info.stdout.matchAll(/([\w-]+)(?=\s*:\s*\{)/g),
              (m) => m[1],
            );
          }
          if (!registered.includes(this.runtime)) {
            throw new VmUnavailableError(
              `Runtime "${this.runtime}" is not registered with Docker ` +
                `(docker info lists: ${registered.join(", ") || "(none)"}). ` +
                `Install and register it in dockerd (e.g. gVisor's runsc), ` +
                `or unset ${VM_RUNTIME_ENV} to use the default runtime.`,
            );
          }
        }
        // If `docker info` itself fails (e.g. daemon down), the run attempt
        // below surfaces that error instead.
      }

      // Create container. In desktop mode the container is *created* first
      // (not started), the generated VNC password is copied in as a 0600
      // file, then the container is started. The password therefore never
      // enters PID 1's environment (so /proc/1/environ cannot leak it).
      let runEnv: Record<string, string> | undefined;
      let vncPassword: string | undefined;
      if (this.desktop) {
        vncPassword = generateVncPassword();
        this.desktopPasswords.set(userId, vncPassword);
        runEnv = { DISPLAY: DESKTOP_DISPLAY };
      }
      const start = await this.run(
        buildRunArgs({
          containerName: name,
          volume: vol,
          image: this.image,
          memory: this.memory,
          cpus: this.cpus,
          pidsLimit: this.pidsLimit,
          runtime: this.runtime,
          network: this.network,
          desktop: this.desktop,
          publishDesktopPort: this.localPublish,
          create: this.desktop,
          shmSize: this.desktop ? DESKTOP_SHM_SIZE : undefined,
          env: runEnv,
          labels: { [VM_OWNER_LABEL]: key },
        }),
        runEnv ? { env: runEnv as NodeJS.ProcessEnv } : undefined,
      );
      if (start.code !== 0) {
        // A requested runtime the daemon does not know is a configuration
        // error with a clear message — not a silent fallback.
        if (this.runtime && isRuntimeMissingError(start.stderr)) {
          throw new VmUnavailableError(
            `Runtime "${this.runtime}" is not available to Docker: ` +
              `${start.stderr.trim() || `exit code ${start.code}`}. ` +
              `Install and register it in dockerd (e.g. gVisor's runsc), ` +
              `or unset ${VM_RUNTIME_ENV} to use the default runtime.`,
          );
        }
        throw new VmUnavailableError(
          `Failed to start container ${name}: ${start.stderr.trim() || `exit code ${start.code}`}`,
        );
      }
      if (this.desktop) {
        await this.startCreated(name, vncPassword);
      }
    } else {
      // The container already exists: re-apply the resource limits so a VM
      // created before the limits were configured cannot keep running
      // without a CPU / memory / PID ceiling.
      await this.applyLimits(name);
      if (
        stateStatus === "exited" ||
        stateStatus === "paused" ||
        stateStatus === "dead" ||
        // "created" means the container was created but never started (e.g.
        // a desktop-mode create whose start was interrupted): without this
        // the handle below would point at a container that never runs and
        // the next exec would fail instead of transparently restarting it.
        stateStatus === "created"
      ) {
        const s = await this.run(["start", name]);
        if (s.code !== 0) {
          throw new VmUnavailableError(
            `Failed to start container ${name}: ${s.stderr.trim() || `exit code ${s.code}`}`,
          );
        }
      }
    }

    return { userId, containerName: name, createdAt: Date.now() };
  }

  async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (opts?.signal?.aborted) {
      return { exitCode: 130 };
    }

    // Forward env values to the docker CLI process only; argv carries just the
    // validated names, so secrets never show up in the process table.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const execEnv: Record<string, string> = opts?.env ? { ...opts.env } : {};
    // Desktop containers run a desktop on DISPLAY=:1; forward it (by name, so
    // agent commands in the terminal can open GUI apps on the shared desktop)
    // unless the caller passed an explicit DISPLAY.
    if (this.desktop && execEnv.DISPLAY === undefined) {
      execEnv.DISPLAY = DESKTOP_DISPLAY;
    }
    for (const [key, value] of Object.entries(execEnv)) {
      if (value !== undefined) env[key] = value;
    }

    // When a deadline is set, run the command under GNU timeout *inside* the
    // container so the kill lands on the container process, not just the CLI.
    // timeout exits 124 after its own trigger, which also gives us the promised
    // exit code without any translation on our side.
    const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
    const innerCmd = timeoutMs ? buildTimeoutWrap(cmd, timeoutMs) : cmd;
    // With a cancel signal, run the command in its own session and record its
    // process group, so abort cleanup can target only this exec. Concurrent
    // execs (the default quota is two) must survive another exec's abort.
    const pgidFile = opts?.signal
      ? (validPgidFile(opts.pgidFile) ?? execPgidPath(randomBytes(8).toString("hex")))
      : undefined;
    const trackedCmd = pgidFile ? buildTrackedCommand(pgidFile, innerCmd) : innerCmd;
    const effectiveOpts = Object.keys(execEnv).length > 0 ? { ...opts, env: execEnv } : opts;
    const argv = buildExecArgs(handle.containerName, trackedCmd, effectiveOpts);

    return new Promise((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let timedOut = false;
      let removeAbort: (() => void) | null = null;

      const cp = this.spawnFn("docker", argv, { env, shell: false });

      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const clearTimers = () => {
        if (t) clearTimeout(t);
        if (killTimer) clearTimeout(killTimer);
        killTimer = null;
      };
      // SIGTERM first; a CLI that ignores it gets SIGKILL after the grace
      // period, so an aborted/timed-out exec never leaves a zombie client.
      const terminate = () => {
        try { cp.kill("SIGTERM"); } catch { /* ignore */ }
        if (!killTimer) {
          killTimer = setTimeout(() => {
            try { cp.kill("SIGKILL"); } catch { /* ignore */ }
          }, this.killGraceMs);
          killTimer.unref?.();
        }
      };

      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (removeAbort) removeAbort();
        resolve({ exitCode: code });
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (removeAbort) removeAbort();
        reject(err);
      };

      // Every stdio stream gets an error listener. A child that closes a pipe
      // early (target is a directory, disk full, container gone) reports EPIPE
      // here; without these listeners Node would raise an uncaught exception
      // and take the server down.
      watchChildStream(cp.stdout, (err) => fail(vmStreamError("stdout", err)));
      watchChildStream(cp.stderr, (err) => fail(vmStreamError("stderr", err)));

      if (opts?.signal) {
        const onAbort = () => {
          if (settled) return;
          aborted = true;
          terminate();
          // Best-effort: kill the process group recorded for THIS exec only,
          // so concurrent execs in the same container keep running. Scoped
          // cleanup; if the daemon is wedged, the CLI kill still resolves.
          if (pgidFile) {
            this.run(buildExecKillArgs(handle.containerName, pgidFile), { timeoutMs: 3000 })
              .catch(() => { /* best-effort */ });
          }
        };
        removeAbort = () => opts.signal!.removeEventListener("abort", onAbort);
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Backstop only: the in-container `timeout` wrapper normally kills the
      // command first and exits 124. This timer only guards against a wedged
      // docker CLI that never closes after the deadline.
      const t = timeoutMs
        ? setTimeout(() => {
            if (settled) return;
            timedOut = true;
            terminate();
          }, timeoutMs + this.killGraceMs)
        : null;

      cp.on("error", fail);

      cp.on("close", (code, signal) => {
        if (aborted) settle(130);
        else if (timedOut) settle(124);
        else if (code === null) {
          // The docker CLI was killed by a signal we did not trigger (not an
          // abort, not our dead-man timeout). That is a failure, never a
          // successful exit: report the signal instead of `code ?? 0`.
          fail(new VmUnavailableError(`docker exec was terminated by ${signal ?? "an unknown signal"}.`));
        } else settle(code);
      });

      if (opts?.onStdout) {
        cp.stdout?.on("data", (buf) => opts?.onStdout?.(String(buf)));
      }
      if (opts?.onStderr) {
        cp.stderr?.on("data", (buf) => opts?.onStderr?.(String(buf)));
      }

      if (opts?.stdin !== undefined) {
        if (cp.stdin) {
          // Backpressure-aware write; a broken pipe rejects this exec with a
          // typed VmStreamError instead of crashing the process.
          writeChildStdin(cp.stdin, opts.stdin, (err) => fail(vmStreamError("stdin", err)));
        } else {
          fail(vmStreamError("stdin", undefined));
        }
      }
    });
  }

  async writeFile(handle: VmHandle, path: string, content: string): Promise<void> {
    if (!path.startsWith("/")) {
      throw new Error(`writeFile requires an absolute path, got ${JSON.stringify(path)}`);
    }
    if (/[\x00-\x1f\x7f"]/.test(path)) {
      throw new Error(`writeFile path contains forbidden characters: ${JSON.stringify(path)}`);
    }

    // Create the parent directory first.
    const idx = path.lastIndexOf("/");
    const dir = idx > 0 ? path.slice(0, idx) : "/";
    const mkdir = await this.exec(handle, ["mkdir", "-p", dir], {
      timeoutMs: this.dockerTimeouts.standard,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(`writeFile failed to create directory ${dir}`);
    }

    // Refuse a symlink at the final component (the O_NOFOLLOW equivalent for
    // shell redirection): the manager resolves symlinks first, so this only
    // catches a race or a direct driver call.
    let stderr = "";
    const res = await this.exec(
      handle,
      ["sh", "-c", 'if [ -L "$1" ]; then echo "refusing to write through a symlink" >&2; exit 40; fi; cat > "$1"', "sh", path],
      {
        stdin: content,
        // Content size varies; use the long deadline so a wedged daemon
        // cannot hang the write (and its caller's lock) forever.
        timeoutMs: this.dockerTimeouts.long,
        onStderr: (c) => { stderr += c; },
      },
    );
    if (res.exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${res.exitCode}`;
      // The shell refuses `cat > dir` with "Is a directory"; surface that as a
      // typed file error so routes can answer 4xx instead of blaming the VM.
      if (/\bis a directory\b/i.test(detail)) {
        throw new VmFileError("not_a_file", `Cannot write ${path}: it is a directory.`);
      }
      throw new Error(`writeFile failed: ${detail}`);
    }
  }

  /**
   * Resolve `path` inside the container, following symlinks, and require the
   * canonical result to stay under /workspace. `realpath -e` needs the path
   * to exist (reads); `realpath -m` tolerates a missing final component
   * (write destinations), while still following existing links.
   */
  async realpath(handle: VmHandle, path: string, opts?: RealpathOptions): Promise<string> {
    // Defense in depth: normalize lexically before the in-container resolve.
    const lexical = resolveWorkspacePath(path);
    const flag = opts?.allowMissing ? "-m" : "-e";
    const res = await this.run(["exec", handle.containerName, "realpath", flag, "--", lexical]);
    if (res.code !== 0) {
      if (res.code === 127) {
        throw new VmFileError("unsupported", "The VM image has no `realpath` binary.");
      }
      if (opts?.allowMissing) {
        // A symlink loop or unreadable parent: refuse rather than write blind.
        throw new VmPathError("invalid_path", `Could not resolve path: ${path}`);
      }
      // The path does not exist. Resolve it leniently to decide whether a
      // symlink redirects it outside /workspace: containment is checked
      // before existence so a dangling outside link is refused, not 404'd.
      const lenient = await this.run(["exec", handle.containerName, "realpath", "-m", "--", lexical]);
      const lenientPath = lenient.stdout.trim();
      if (lenient.code === 0 && lenientPath) assertWorkspaceContainment(lenientPath);
      throw new VmFileError("not_found", `No such file or directory: ${path}`);
    }
    const resolved = res.stdout.trim();
    if (!resolved) {
      throw new VmPathError("invalid_path", `Could not resolve path: ${path}`);
    }
    return assertWorkspaceContainment(resolved);
  }

  async readFile(handle: VmHandle, path: string): Promise<string> {
    // `cat --` so paths starting with `-` are not parsed as flags.
    const res = await this.run(["exec", handle.containerName, "cat", "--", path]);
    if (res.code !== 0) {
      throw new Error(`readFile failed: ${res.stderr}`);
    }
    // Never hand back a silently truncated file: past the buffered-output
    // cap the caller must use readFileBytes with an explicit limit.
    if (res.stdoutTruncated) {
      throw new Error(
        `readFile failed: ${path} exceeds the ${this.maxRunStdoutBytes}-byte buffered read cap; use readFileBytes with an explicit limit.`,
      );
    }
    return res.stdout;
  }

  /** Metadata for one path, via coreutils stat. */
  async stat(handle: VmHandle, path: string): Promise<VmFileStat> {
    // -c does not interpret escapes, so the separator is a real tab.
    const res = await this.run(["exec", handle.containerName, "stat", "-c", "%F\t%s\t%Y", "--", path]);
    if (res.code !== 0) {
      throw new VmFileError("not_found", `No such file or directory: ${path}`);
    }
    const [kind, size, mtime] = res.stdout.trim().split("\t");
    const seconds = Number(mtime);
    return {
      path,
      type: statType(kind),
      size: Number(size) || 0,
      modifiedAt: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
    };
  }

  /** One level of a directory, via GNU find's -printf (NUL separated). */
  async listDir(handle: VmHandle, path: string): Promise<VmDirEntry[]> {
    // The format string is interpreted by find, so "\0" is a NUL separator and
    // names containing spaces or newlines survive the round trip.
    const res = await this.run([
      "exec", handle.containerName,
      "find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\0%s\\0%T@\\0%f\\0",
    ]);
    if (res.code !== 0) {
      if (res.code === 127) {
        throw new VmFileError("unsupported", "The VM image has no `find` binary.");
      }
      throw new VmFileError("not_found", `No such file or directory: ${path}`);
    }
    const fields = res.stdout.split("\0");
    const entries: VmDirEntry[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const [kind, size, mtime, name] = fields.slice(i, i + 4);
      if (!name) continue;
      const seconds = Number(mtime);
      entries.push({
        name,
        path: path.endsWith("/") ? `${path}${name}` : `${path}/${name}`,
        type: entryType(kind),
        size: Number(size) || 0,
        modifiedAt: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
      });
    }
    return entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
    );
  }

  /** Raw bytes of a file, never more than maxBytes. */
  async readFileBytes(handle: VmHandle, path: string, maxBytes: number): Promise<VmFileBytes> {
    const stat = await this.stat(handle, path);
    if (stat.type === "directory") {
      throw new VmFileError("not_a_file", `Not a file: ${path}`);
    }
    // head -c caps the read even if the file grows between stat and read.
    // The matching maxStdoutBytes keeps runRaw's buffered-output cap from
    // truncating a read the caller explicitly sized.
    const res = await this.runRaw(
      ["exec", handle.containerName, "head", "-c", String(Math.max(0, maxBytes)), "--", path],
      { maxStdoutBytes: Math.max(1, maxBytes) },
    );
    if (res.code !== 0) {
      if (res.code === 127) {
        throw new VmFileError("unsupported", "The VM image has no `head` binary.");
      }
      throw new VmFileError("not_found", `No such file or directory: ${path}`);
    }
    return {
      content: res.stdout,
      size: stat.size,
      truncated: stat.size > res.stdout.length,
    };
  }

  async status(handle: VmHandle): Promise<VmState> {
    const res = await this.run(["container", "inspect", "-f", "{{.State.Status}}", handle.containerName]);
    const s = res.stdout.trim();
    if (res.code !== 0) {
      return { status: "missing", error: res.stderr };
    }
    if (s === "running") return { status: "running" };
    if (s === "exited" || s === "dead") return { status: "stopped" };
    if (s === "created" || s === "restarting") return { status: "creating" };
    return { status: "stopped" };
  }

  async stop(handle: VmHandle): Promise<void> {
    const res = await this.run(["stop", handle.containerName]);
    if (res.code !== 0) {
      throw new Error(`stop failed: ${res.stderr}`);
    }
  }

  async reset(handle: VmHandle): Promise<void> {
    // Remove the container and its volume to wipe state. A silent failure
    // here would leave the user's files behind after a "wipe VM" request.
    //
    // "No such container" / "No such volume" means the resource is already
    // gone, which is exactly what reset asks for. The volume removal is
    // attempted even when the container step fails, so a missing container
    // can never strand the user's files.
    const rm = await this.run(["rm", "-f", handle.containerName]);
    const containerGone = rm.code === 0 || isNotFoundError(rm.stderr);
    const vol = volumeNameFor(handle.userId);
    const rmVol = await this.run(["volume", "rm", "-f", vol]);
    const volumeGone = rmVol.code === 0 || isNotFoundError(rmVol.stderr);
    if (!containerGone) {
      throw new Error(`reset failed to remove container: ${rm.stderr.trim() || `exit code ${rm.code}`}`);
    }
    if (!volumeGone) {
      throw new Error(`reset failed to remove volume: ${rmVol.stderr.trim() || `exit code ${rmVol.code}`}`);
    }
  }

  /**
   * Copy one named volume's contents into another with a throwaway helper
   * container (the same `cp -a` pattern the legacy migration uses). Used
   * both ways: snapshot backs the live /workspace volume up into the
   * per-snapshot volume, restore copies it back. With `clearDst` the
   * destination is emptied first (files deleted after the snapshot must not
   * survive a restore); without it the copy overlays.
   */
  private async copyVolume(
    src: string,
    dst: string,
    clearDst: boolean,
    context: string,
  ): Promise<void> {
    const script = clearDst
      ? "find /dst -mindepth 1 -delete; cp -a /src/. /dst/"
      : "cp -a /src/. /dst/";
    // Run the copy as root: a named volume is created root-owned (0755) while
    // the VM image's default user is `node` (uid 1000), so a non-root cp cannot
    // write a single file into the fresh destination volume and every snapshot
    // fails with "cp: cannot create regular file '/dst/...': Permission denied".
    // `cp -a` still preserves the owners of the copied tree.
    const res = await this.run([
      "run", "--rm",
      "-u", "0:0",
      "-v", `${src}:/src`,
      "-v", `${dst}:/dst`,
      this.image,
      "sh", "-c", script,
    ]);
    if (res.code !== 0) {
      throw new Error(`${context}: ${res.stderr.trim() || `exit code ${res.code}`}`);
    }
  }

  async snapshot(handle: VmHandle, label: string): Promise<VmSnapshot> {
    validateSnapshotLabel(label);
    const image = `${snapshotRepoFor(handle.userId)}:${label}`;
    const commitRes = await this.run(["commit", handle.containerName, image]);
    if (commitRes.code !== 0) {
      throw new Error(`snapshot failed: ${commitRes.stderr}`);
    }
    // `docker commit` captures only the container's writable layer — the
    // /workspace named volume is NOT in the image. Back it up into the
    // per-snapshot volume, or a restore would roll back installed state
    // while silently keeping every workspace mutation.
    const snapVol = snapshotVolumeFor(handle.userId, label);
    try {
      await this.ensureVolume(snapVol, { [VM_OWNER_LABEL]: ownerKeyFor(handle.userId) });
      await this.copyVolume(
        volumeNameFor(handle.userId),
        snapVol,
        true,
        `snapshot failed to back up workspace volume ${snapVol}`,
      );
    } catch (err) {
      // Never leave a half-created snapshot behind: an image without its
      // workspace backup would restore as if the workspace had never
      // changed. Drop both halves and report the failure.
      await this.run(["rmi", image]).catch(() => {});
      await this.run(["volume", "rm", "-f", snapVol]).catch(() => {});
      throw err;
    }
    return { label, createdAt: Date.now(), image };
  }

  async listSnapshots(handle: VmHandle): Promise<VmSnapshot[]> {
    const repo = snapshotRepoFor(handle.userId);
    const res = await this.run([
      "images",
      "--filter",
      `reference=${repo}`,
      "--format",
      "{{.Tag}}\t{{.CreatedAt}}",
    ]);
    if (res.code !== 0) {
      throw new Error(`listSnapshots failed: ${res.stderr}`);
    }
    const snapshots: VmSnapshot[] = [];
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [tag, created] = line.split("\t");
      if (!tag || tag === "<none>") continue;
      const createdAt = created ? Date.parse(created) : NaN;
      snapshots.push({
        label: tag,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        image: `${repo}:${tag}`,
      });
    }
    return snapshots.sort((a, b) => b.createdAt - a.createdAt);
  }

  async restore(handle: VmHandle, label: string): Promise<void> {
    validateSnapshotLabel(label);
    const image = `${snapshotRepoFor(handle.userId)}:${label}`;
    const inspect = await this.run(["image", "inspect", "-f", "{{.Id}}", image]);
    if (inspect.code !== 0) {
      throw new Error(`Snapshot not found: ${label}`);
    }
    // A snapshot is an image *plus* its workspace backup volume. An image
    // without the backup (e.g. created before workspace backups existed)
    // must fail loudly — restoring it would silently keep the current
    // /workspace instead of rolling it back.
    const snapVol = snapshotVolumeFor(handle.userId, label);
    const volLs = await this.run(["volume", "ls", "-q", "-f", `name=${snapVol}`]);
    const backupExists = volLs.stdout
      .split("\n")
      .some((line) => line.trim() === snapVol);
    if (!backupExists) {
      throw new Error(`Snapshot not found: ${label} (workspace backup missing)`);
    }

    // Gate: refuse to destroy a container that is not owned by the caller.
    await this.requireOwnership(handle.containerName, handle.userId);

    // The container must actually be gone before the volume is touched:
    // a live container could rewrite /workspace while the backup is being
    // copied back, and the recreate below would fail on a name conflict.
    const rm = await this.run(["rm", "-f", handle.containerName]);
    if (rm.code !== 0 && !isNotFoundError(rm.stderr)) {
      throw new Error(
        `restore failed to remove container: ${rm.stderr.trim() || `exit code ${rm.code}`}`,
      );
    }

    // Roll the workspace volume back to the snapshot contents *before* the
    // new container mounts it. The volume is emptied first so files created
    // after the snapshot do not survive the restore.
    await this.copyVolume(
      snapVol,
      volumeNameFor(handle.userId),
      true,
      `restore failed to roll back workspace volume from ${snapVol}`,
    );

    // Recreate the container from the snapshot image, mounting the restored
    // workspace volume, so both installed state and /workspace come back.
    let runEnv: Record<string, string> | undefined;
    let vncPassword: string | undefined;
    if (this.desktop) {
      vncPassword = generateVncPassword();
      this.desktopPasswords.set(handle.userId, vncPassword);
      runEnv = { DISPLAY: DESKTOP_DISPLAY };
    }
    const start = await this.run(
      buildRunArgs({
        containerName: handle.containerName,
        volume: volumeNameFor(handle.userId),
        image,
        memory: this.memory,
        cpus: this.cpus,
        pidsLimit: this.pidsLimit,
        runtime: this.runtime,
        network: this.network,
        desktop: this.desktop,
        publishDesktopPort: this.localPublish,
        create: this.desktop,
        shmSize: this.desktop ? DESKTOP_SHM_SIZE : undefined,
        env: runEnv,
        labels: { [VM_OWNER_LABEL]: ownerKeyFor(handle.userId) },
      }),
      runEnv ? { env: runEnv as NodeJS.ProcessEnv } : undefined,
    );
    if (start.code !== 0) {
      throw new Error(`restore failed: ${start.stderr.trim() || `exit code ${start.code}`}`);
    }
    if (this.desktop) {
      await this.startCreated(handle.containerName, vncPassword);
    }
  }

  /**
   * Recreate the container from a snapshot image and remount the live
   * workspace volume. Does not copy the snapshot's workspace backup.
   */
  async bootFromImage(handle: VmHandle, label: string): Promise<void> {
    validateSnapshotLabel(label);
    const image = `${snapshotRepoFor(handle.userId)}:${label}`;
    const inspect = await this.run(["image", "inspect", "-f", "{{.Id}}", image]);
    if (inspect.code !== 0) {
      throw new Error(`Snapshot not found: ${label}`);
    }
    await this.requireOwnership(handle.containerName, handle.userId);
    const rm = await this.run(["rm", "-f", handle.containerName]);
    if (rm.code !== 0 && !isNotFoundError(rm.stderr)) {
      throw new Error(
        `bootFromImage failed to remove container: ${rm.stderr.trim() || `exit code ${rm.code}`}`,
      );
    }
    let runEnv: Record<string, string> | undefined;
    let vncPassword: string | undefined;
    if (this.desktop) {
      vncPassword = generateVncPassword();
      this.desktopPasswords.set(handle.userId, vncPassword);
      runEnv = { DISPLAY: DESKTOP_DISPLAY };
    }
    const start = await this.run(
      buildRunArgs({
        containerName: handle.containerName,
        volume: volumeNameFor(handle.userId),
        image,
        memory: this.memory,
        cpus: this.cpus,
        pidsLimit: this.pidsLimit,
        runtime: this.runtime,
        network: this.network,
        desktop: this.desktop,
        publishDesktopPort: this.localPublish,
        create: this.desktop,
        shmSize: this.desktop ? DESKTOP_SHM_SIZE : undefined,
        env: runEnv,
        labels: { [VM_OWNER_LABEL]: ownerKeyFor(handle.userId) },
      }),
      runEnv ? { env: runEnv as NodeJS.ProcessEnv } : undefined,
    );
    if (start.code !== 0) {
      throw new Error(`bootFromImage failed: ${start.stderr.trim() || `exit code ${start.code}`}`);
    }
    if (this.desktop) {
      await this.startCreated(handle.containerName, vncPassword);
    }
  }

  /**
   * Delete a checkpoint: the committed image *and* its per-snapshot
   * workspace backup volume, so neither half leaks. A snapshot is only
   * "not found" when neither half exists — a half-created snapshot (image
   * without backup, or vice versa) still deletes the half that is there.
   *
   * Note the live-VM edge: when the VM was recreated from this snapshot
   * (restore), the snapshot image backs the running container and `docker
   * rmi` refuses (even the daemon reports it as in use). The delete then
   * fails with the daemon's error and the snapshot stays until the VM is
   * recreated from another image — deleting the image under a running
   * container would be a lie either way.
   */
  async deleteSnapshot(handle: VmHandle, label: string): Promise<void> {
    validateSnapshotLabel(label);
    const image = `${snapshotRepoFor(handle.userId)}:${label}`;
    const snapVol = snapshotVolumeFor(handle.userId, label);
    const inspect = await this.run(["image", "inspect", "-f", "{{.Id}}", image]);
    const imageExists = inspect.code === 0;
    const volLs = await this.run(["volume", "ls", "-q", "-f", `name=${snapVol}`]);
    const volumeExists =
      volLs.code === 0 &&
      volLs.stdout.split("\n").some((line) => line.trim() === snapVol);
    if (!imageExists && !volumeExists) {
      throw new Error(`Snapshot not found: ${label}`);
    }
    if (imageExists) {
      const rmi = await this.run(["rmi", image]);
      // Restoring from a snapshot recreates the live container *from* that
      // snapshot image, so the user's own VM references it and a plain `rmi`
      // fails with "conflict: ... is using its referenced image". Force the
      // untag: the running container keeps its layers, the label is gone.
      const rmiFinal =
        rmi.code !== 0 && /conflict|is using its referenced image/i.test(rmi.stderr)
          ? await this.run(["rmi", "-f", image])
          : rmi;
      if (rmiFinal.code !== 0) {
        throw new Error(
          `delete snapshot failed to remove image ${image}: ${rmiFinal.stderr.trim() || `exit code ${rmiFinal.code}`}`,
        );
      }
    }
    if (volumeExists) {
      const rmVol = await this.run(["volume", "rm", "-f", snapVol]);
      if (rmVol.code !== 0) {
        throw new Error(
          `delete snapshot failed to remove volume ${snapVol}: ${rmVol.stderr.trim() || `exit code ${rmVol.code}`}`,
        );
      }
    }
  }
}
