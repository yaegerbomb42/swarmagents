/**
 * Clipboard helpers for computer-mcp (pure plumbing, injectable spawn).
 *
 * `xclip -i` reads stdin, then forks a background process that owns the X
 * selection until another client takes it. The *parent* exits right away, but
 * the forked child inherits any piped stdout/stderr, so a 'close' event (all
 * stdio closed) never arrives. Waiting for 'close' made every clipboard_set
 * report "timed out" after 5 s even though the clipboard had been set. Resolve
 * on 'exit' instead, and do not pipe stdout/stderr into the long-lived child.
 */

/** Max clipboard text returned to the model by clipboard_get. */
export const MAX_CLIPBOARD_READ_CHARS = 32_000;

/** Cap clipboard text for the model; reports whether it was cut. */
export function capClipboardText(text, max = MAX_CLIPBOARD_READ_CHARS) {
  const value = String(text ?? "");
  if (value.length <= max) return { text: value, truncated: false, total: value.length };
  return { text: value.slice(0, max), truncated: true, total: value.length };
}

/**
 * Write `text` to an X selection with xclip. Resolves
 * `{ ok: true }` or `{ ok: false, error }`; never rejects.
 */
export function writeClipboard({ spawnImpl, text, selection = "clipboard", env, timeoutMs = 5_000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl("xclip", ["-i", "-selection", selection], {
        env,
        shell: false,
        // stdin only: piped stdout/stderr would be inherited by xclip's
        // forked selection owner and keep the streams open indefinitely.
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      settle({ ok: false, error: "timed out" });
    }, timeoutMs);
    child.on("error", (err) => settle({ ok: false, error: String(err) }));
    child.on("exit", (code, signal) => {
      if (code === 0) settle({ ok: true });
      else settle({ ok: false, error: signal ? `killed by ${signal}` : `exit code ${code}` });
    });
    child.stdin?.on?.("error", () => {});
    child.stdin?.end(String(text));
  });
}
