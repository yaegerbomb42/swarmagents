// Server-only persistent Linux sandbox VM types.
// These interfaces define the contract between the rest of the app and
// the per-user container that the agent lives in.

/** Handle returned by ensure(); used as a token for every operation. */
export interface VmHandle {
  userId: string;
  containerName: string;
  /** Epoch ms when the handle was created (not the container itself). */
  createdAt: number;
}

/** Options for the exec() call. */
export interface ExecOptions {
  cwd?: string;
  /** Environment variables to forward into the VM (names only appear in argv). */
  env?: Record<string, string>;
  /** Data written to the command's stdin (requires the driver to keep stdin open). */
  stdin?: string | Buffer;
  timeoutMs?: number;
  /**
   * Manager quota profile. Terminal commands use the short SWARM_VM_MAX_*
   * limits by default; Claude Code invocations use SWARM_VM_AGENT_MAX_*.
   */
  quotaProfile?: "terminal" | "agent";
  /**
   * Concurrency-quota lane. "general" (default) draws from the per-user
   * pool shared with agent/terminal work; "control" draws from a small
   * reserved pool so host control-plane execs (kill/reap, health probes,
   * git/status checks) are never starved by long-running tool execs.
   * Only short, bounded host operations should use the control lane.
   */
  lane?: "general" | "control";
  signal?: AbortSignal;
  /**
   * In-container path of the process-group marker file for this exec. When
   * set (and a signal is present), the driver records the exec's setsid
   * process group in this file instead of a random one, so the caller can
   * later kill exactly that group. Only paths under /tmp/.swarm-exec-* are
   * honored; anything else falls back to a random marker.
   */
  pgidFile?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Result of an exec() call. */
export interface ExecResult {
  exitCode: number;
  /** True when output was cut off by the selected terminal/agent manager quota. */
  truncated?: boolean;
}

/** Current runtime status of a VM. */
export type VmStatus = "running" | "stopped" | "missing" | "creating" | "error";

export interface VmState {
  status: VmStatus;
  /** Error message when status === "error". */
  error?: string;
}

/** Kind of an entry inside the VM filesystem. */
export type VmEntryType = "file" | "directory" | "other";

/** Metadata about one path inside the VM. */
export interface VmFileStat {
  path: string;
  type: VmEntryType;
  /** Size in bytes (0 for directories). */
  size: number;
  /** Last modification time in epoch ms, when the driver knows it. */
  modifiedAt?: number;
}

/** One entry of a directory listing. */
export interface VmDirEntry {
  name: string;
  path: string;
  type: VmEntryType;
  size: number;
  modifiedAt?: number;
}

/** Raw bytes of a file read, capped by the caller. */
export interface VmFileBytes {
  /** The bytes read (never more than the requested cap). */
  content: Buffer;
  /** Full size of the file in bytes. */
  size: number;
  /** True when the file was larger than the requested cap. */
  truncated: boolean;
}

/**
 * A browser-viewable desktop endpoint for a VM (desktop mode only).
 *
 * `host` is the container's IP on its docker network, `port` is the
 * in-container VNC web client port (6080). The `password` is the per-container
 * random VNC password the driver generated server-side; it is never sent to
 * the browser in clear and never logged. The port is never published to a
 * host port — only reachable from inside the docker network.
 */
export interface VmDesktopEndpoint {
  host: string;
  port: number;
  password: string;
}

/** A point-in-time checkpoint of a VM that can be restored later. */
export interface VmSnapshot {
  /** User-supplied label, unique per user. */
  label: string;
  /** Epoch ms when the snapshot was created. */
  createdAt: number;
  /** Driver-specific image/reference backing the snapshot, when applicable. */
  image?: string;
}

/** Options for resolving a path with symlinks resolved inside the VM. */
export interface RealpathOptions {
  /**
   * Allow the final component (or its target) to not exist yet — used for
   * write destinations. Existing symlinks are still followed and checked.
   */
  allowMissing?: boolean;
}

/** Every driver must satisfy this interface. */
export interface VmDriver {
  /** Make sure a VM exists for the user (idempotent). */
  ensure(userId: string): Promise<VmHandle>;

  /** Run a command (argv array) inside the VM, streaming stdout/stderr through callbacks. */
  exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult>;

  /**
   * Resolve `path` inside the VM (following symlinks) and return the absolute
   * canonical path. Implementations must throw VmPathError when the resolved
   * path escapes /workspace, so a workspace symlink cannot redirect a read or
   * write to /etc, /proc, or the host.
   */
  realpath?(handle: VmHandle, path: string, opts?: RealpathOptions): Promise<string>;

  /** Write a file inside the VM. */
  writeFile(handle: VmHandle, path: string, content: string): Promise<void>;

  /** Read a file from inside the VM. */
  readFile(handle: VmHandle, path: string): Promise<string>;

  /** Metadata for one path inside the VM (optional capability). */
  stat?(handle: VmHandle, path: string): Promise<VmFileStat>;

  /** List one directory level inside the VM (optional capability). */
  listDir?(handle: VmHandle, path: string): Promise<VmDirEntry[]>;

  /** Read raw bytes of a file, never more than maxBytes (optional capability). */
  readFileBytes?(handle: VmHandle, path: string, maxBytes: number): Promise<VmFileBytes>;

  /** Get VM status. */
  status(handle: VmHandle): Promise<VmState>;

  /** Stop the VM (but keep the volume for later restart). */
  stop(handle: VmHandle): Promise<void>;

  /** Destroy the VM and wipe its volume. */
  reset(handle: VmHandle): Promise<void>;

  /** Optional: create a checkpoint of the VM (for drivers that support it). */
  snapshot?(handle: VmHandle, label: string): Promise<VmSnapshot>;

  /** Optional: list the checkpoints available for this VM. */
  listSnapshots?(handle: VmHandle): Promise<VmSnapshot[]>;

  /** Optional: roll the VM back to a previously created checkpoint. */
  restore?(handle: VmHandle, label: string): Promise<void>;

  /**
   * Optional: recreate the container from a snapshot image while keeping the
   * live workspace volume. Used by warm golden snapshots so dependency caches
   * in the image layer are reused without rolling back the user's files.
   */
  bootFromImage?(handle: VmHandle, label: string): Promise<void>;

  /**
   * Optional: delete a previously created checkpoint — both halves, the
   * committed image and the per-snapshot workspace backup volume.
   */
  deleteSnapshot?(handle: VmHandle, label: string): Promise<void>;

  /**
   * Optional: the VM image this driver creates containers from (the run's
   * VM config — e.g. the SWARM_VM_IMAGE default or the desktop image).
   * Drivers without a container image (fake/transcript) leave it unset.
   */
  image?: string;

  /**
   * Optional: the browser-viewable desktop endpoint for the VM. Only
   * available in desktop mode; every other driver returns null.
   */
  desktopEndpoint?(handle: VmHandle): Promise<VmDesktopEndpoint | null>;

  /**
   * Optional: the VM container's IP on its docker network, or null when the
   * container is not running / has no IP. The preview proxy dials this host
   * directly (same mechanism as desktopEndpoint's `host`); the port is never
   * published to the host. Drivers that do not run VMs as containers omit
   * this and the preview proxy is unavailable for them.
   */
  containerIp?(handle: VmHandle): Promise<string | null>;

  /**
   * Optional: true when this driver runs VMs in desktop mode
   * (SWARM_VM_DESKTOP=1). Absent/undefined means desktop mode is off; the
   * UI then keeps the pre-desktop screen (terminal/browser/files only).
   */
  readonly desktop?: boolean;
}
