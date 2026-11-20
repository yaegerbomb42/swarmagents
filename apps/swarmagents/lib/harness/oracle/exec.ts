/**
 * The exec channel the oracle gate runs through. Same shape as the shadow
 * verifier's ShadowExec (lib/verification/shadow-verifier.ts), so the
 * runtime can hand the gate the run's VM exec unchanged: argv arrays only,
 * never a shell string built from patch content.
 */

import type { ShadowExec, ShadowExecResult } from "../../verification/shadow-verifier";

export type OracleExec = ShadowExec;
export type OracleExecResult = ShadowExecResult;

/** Largest base64 chunk passed as one argv element (well under MAX_ARG_STRLEN). */
const WRITE_CHUNK_CHARS = 64 * 1024;

/**
 * Write `content` to `filePath` through exec alone (the VM channel has no
 * stdin): truncate, then append base64 chunks decoded by `base64 -d`.
 * Content only ever travels as a positional argv value, never interpolated
 * into the `sh -c` script.
 */
export async function writeFileViaExec(exec: OracleExec, filePath: string, content: string): Promise<void> {
  const truncate = await exec(["sh", "-c", ': > "$1"', "sh", filePath]);
  if (truncate.exitCode !== 0) throw new Error(`cannot write ${filePath}: ${truncate.stderr.trim()}`);
  const encoded = Buffer.from(content, "utf8").toString("base64");
  for (let at = 0; at < encoded.length; at += WRITE_CHUNK_CHARS) {
    const chunk = encoded.slice(at, at + WRITE_CHUNK_CHARS);
    const res = await exec(["sh", "-c", 'printf %s "$1" | base64 -d >> "$2"', "sh", chunk, filePath]);
    if (res.exitCode !== 0) throw new Error(`cannot write ${filePath}: ${res.stderr.trim()}`);
  }
}

/** Run with a timeout: aborts the exec's signal and reports exit 124 like `timeout(1)`. */
export async function execWithTimeout(
  exec: OracleExec,
  cmd: string[],
  opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<OracleExecResult & { timedOut: boolean }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<OracleExecResult & { timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ exitCode: 124, stdout: "", stderr: `timed out after ${opts.timeoutMs}ms`, timedOut: true });
    }, opts.timeoutMs);
  });
  try {
    const run = exec(cmd, { cwd: opts.cwd, signal: controller.signal }).then((r) => ({ ...r, timedOut: false }));
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
