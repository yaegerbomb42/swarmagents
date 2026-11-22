/**
 * Incremental line parser for `claude --output-format stream-json`.
 *
 * Stdout arrives as arbitrary UTF-8 chunks that can split a JSON line anywhere,
 * so the parser buffers until a newline (or flush at EOF) and only then attempts
 * to decode. Malformed lines are surfaced via onMalformed and dropped — one
 * corrupt line must never kill the run.
 *
 * The line buffer is bounded: a process that emits an unbroken stream with no
 * newlines must not be able to grow the buffer without limit and OOM the host.
 */

export interface StreamJsonHandlers {
  onLine(raw: unknown, line: string): void;
  onMalformed?(line: string): void;
}

export interface StreamJsonOptions {
  /**
   * Maximum number of characters buffered while waiting for a newline. Once
   * exceeded, a truncated preview is reported via onMalformed and the rest of
   * the unterminated line is discarded until the next newline.
   */
  maxLineBufferChars?: number;
}

export interface StreamJsonParser {
  push(chunk: string): void;
  flush(): void;
}

/** Default cap: 8 MB of buffered stdout without a newline. */
export const DEFAULT_MAX_LINE_BUFFER_CHARS = 8 * 1024 * 1024;
/** How much of an overlong line is included in the onMalformed preview. */
const MALFORMED_PREVIEW_CHARS = 200;

export function createStreamJsonParser(
  handlers: StreamJsonHandlers,
  options: StreamJsonOptions = {},
): StreamJsonParser {
  const maxChars = Math.max(1, Math.floor(options.maxLineBufferChars ?? DEFAULT_MAX_LINE_BUFFER_CHARS));
  let buffer = "";
  /** True once an overlong line has been dropped; discard until the next newline. */
  let discarding = false;

  const consume = (line: string) => {
    if (line.trim() === "") return;
    try {
      handlers.onLine(JSON.parse(line), line);
    } catch {
      handlers.onMalformed?.(line);
    }
  };

  return {
    push(chunk) {
      if (discarding) {
        // Drop everything up to and including the next newline, then resume
        // with the remainder of this chunk as the start of a fresh line.
        const nl = chunk.indexOf("\n");
        if (nl === -1) return;
        discarding = false;
        chunk = chunk.slice(nl + 1);
      }

      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        consume(line);
      }

      if (buffer.length > maxChars) {
        const preview = buffer.slice(0, MALFORMED_PREVIEW_CHARS);
        buffer = "";
        discarding = true;
        handlers.onMalformed?.(
          `[stream-json: line buffer exceeded ${maxChars} chars; discarded] ${preview}…`,
        );
      }
    },
    flush() {
      // Always clear the buffer, even when it held only whitespace: leaving a
      // stale prefix would corrupt the next (valid) line after a flush.
      if (!discarding && buffer.trim() !== "") {
        consume(buffer);
      }
      buffer = "";
      discarding = false;
    },
  };
}
