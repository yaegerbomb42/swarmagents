// Classification and last-resort handling for child-process stream failures.
//
// A docker CLI child can exit before its stdin has been fully written: the
// target path is a directory, the workspace volume is full, or the container
// vanished after ensure(). Node then emits EPIPE (or a related stream error)
// on the child's stdio stream. With no `error` listener that becomes an
// uncaught exception and takes down the whole Next.js process — a remote DoS
// reachable from any signed-in upload.
//
// Every spawn site in the VM driver attaches listeners and settles its promise
// through the helpers here. instrumentation.ts additionally installs a
// process-level last resort so a stream error that still escapes a listener is
// logged and ignored instead of killing the server; anything else is fatal.

/** Error codes that mean "the other end of a pipe/socket went away". */
const KNOWN_STREAM_CODES = new Set([
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ECONNRESET",
]);

/** The `code` of a Node errno-style error, when it has one. */
export function streamErrorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True when `err` is a broken-pipe / closed-stream error: the kind that a
 * child-process stdio event reports and that must never be fatal to the
 * server. Unknown errors deliberately return false so they still crash loudly.
 */
export function isKnownStreamError(err: unknown): boolean {
  const code = streamErrorCode(err);
  return code !== undefined && KNOWN_STREAM_CODES.has(code);
}

/** Which stdio stream failed on a spawned child. */
export type ChildStreamName = "stdin" | "stdout" | "stderr";

/**
 * Typed error for a failure on a child's stdio stream. `code` preserves the
 * Node errno code (normally `EPIPE`) so callers can classify it with
 * {@link isKnownStreamError}; the message names the stream and operation.
 */
export class VmStreamError extends Error {
  readonly code: string;
  readonly stream: ChildStreamName;

  constructor(stream: ChildStreamName, code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "VmStreamError";
    this.stream = stream;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Build a {@link VmStreamError} from a raw stdio error. A missing code is
 * reported as EPIPE, the failure mode this guard exists for.
 */
export function vmStreamError(stream: ChildStreamName, err: unknown): VmStreamError {
  const code = streamErrorCode(err) ?? "EPIPE";
  const message =
    stream === "stdin"
      ? `Failed to write to the command's stdin (${code}): the command exited before all input was delivered.`
      : `The command's ${stream} stream failed (${code}).`;
  return new VmStreamError(stream, code, message, err);
}

/** Minimal EventEmitter surface needed by {@link installCrashGuard}. */
export interface CrashGuardTarget {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface CrashGuardOptions {
  /** Where to register listeners (defaults to `process`). */
  target?: CrashGuardTarget;
  /** Sink for log lines (defaults to console.error). */
  log?: (message: string, detail: unknown) => void;
  /** Fatal exit path (defaults to `process.exit`); injectable for tests. */
  exit?: (code: number) => void;
}

let installed = false;

/**
 * Install the process-level last resort exactly once.
 *
 * - Known stream errors (EPIPE and friends) are logged and swallowed: the
 *   process keeps serving requests. These errors belong to one request's child
 *   process and are already reported to that request's promise.
 * - Anything else is logged and the process exits non-zero, matching Node's
 *   default fatal behavior rather than leaving a broken server alive.
 *
 * Returns an uninstall function (mainly for tests). Calling it resets the
 * once-guard so a later install can register again.
 */
export function installCrashGuard(opts: CrashGuardOptions = {}): () => void {
  if (installed) return () => {};
  installed = true;

  const target = opts.target ?? (process as unknown as CrashGuardTarget);
  const log = opts.log ?? ((message: string, detail: unknown) => console.error(message, detail));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const uninstall = () => {
    target.removeListener?.("uncaughtException", onUncaught);
    target.removeListener?.("unhandledRejection", onUnhandledRejection);
    installed = false;
  };

  function onUncaught(err: unknown): void {
    if (isKnownStreamError(err)) {
      log("[crash-guard] ignored stream error; process keeps serving:", err);
      return;
    }
    log("[crash-guard] fatal uncaught exception:", err);
    uninstall();
    exit(1);
  }

  function onUnhandledRejection(reason: unknown): void {
    if (isKnownStreamError(reason)) {
      log("[crash-guard] ignored stream rejection; process keeps serving:", reason);
      return;
    }
    log("[crash-guard] fatal unhandled rejection:", reason);
    uninstall();
    exit(1);
  }

  target.on("uncaughtException", onUncaught);
  target.on("unhandledRejection", onUnhandledRejection);

  return uninstall;
}
