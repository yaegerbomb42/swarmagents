/**
 * Incremental line parser for `claude --output-format stream-json`.
 *
 * Stdout arrives as arbitrary UTF-8 chunks that can split a JSON line anywhere,
 * so the parser buffers until a newline (or flush at EOF) and only then attempts
 * to decode. Malformed lines are surfaced via onMalformed and dropped — one
 * corrupt line must never kill the run.
 */

export interface StreamJsonHandlers {
  onLine(raw: unknown, line: string): void;
  onMalformed?(line: string): void;
}

export interface StreamJsonParser {
  push(chunk: string): void;
  flush(): void;
}

export function createStreamJsonParser(handlers: StreamJsonHandlers): StreamJsonParser {
  let buffer = "";

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
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        consume(line);
      }
    },
    flush() {
      if (buffer.trim() !== "") {
        consume(buffer);
        buffer = "";
      }
    },
  };
}
