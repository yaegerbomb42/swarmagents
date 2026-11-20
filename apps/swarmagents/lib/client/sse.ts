/**
 * Dependency-free SSE (Server-Sent Events) wire parser for the runtime stream
 * endpoint (/api/runtime/stream/[runId]).
 *
 * Decodes the text/event-stream framing incrementally: field lines (`event:`,
 * `data:`, `id:`, `retry:`), comments (`: ...`), multi-line `data:` fields
 * joined with embedded newlines, and dispatch on a blank line. Feed it raw
 * decoded text chunks; it returns only complete messages and holds any partial
 * tail bytes for the next push. Kept deliberately framework-independent so the
 * parser can be unit-tested without a DOM or a fetch mock.
 */

export interface SseMessage {
  /** Value of the most recent `id:` field, if any. Drives Last-Event-ID resume. */
  id?: string;
  /** Event type from the `event:` field; undefined means the default "message". */
  event?: string;
  /** Joined `data:` payload ("" if only an empty data line was sent). */
  data: string;
  /** Milliseconds from a `retry:` field, when present. */
  retryMs?: number;
}

interface Pending {
  id?: string;
  event?: string;
  data?: string;
  retryMs?: number;
}

const FIELD_RE = /^([^:]*):(?: (.*))?$/;

export class SseParser {
  private buf = "";
  private pending: Pending = {};

  /**
   * Feed a decoded text chunk (any part of a frame). Returns every message
   * completed so far; incomplete lines stay buffered until the next push.
   */
  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  /** Process one line; returns a complete message when a blank line dispatches. */
  private line(line: string): SseMessage | null {
    if (line === "") {
      const p = this.pending;
      this.pending = {};
      // Dispatch only if the frame carried data, an event name, or an id.
      if (p.data === undefined && p.event === undefined && p.id === undefined) return null;
      const msg: SseMessage = { data: p.data ?? "" };
      if (p.event !== undefined) msg.event = p.event;
      if (p.id !== undefined) msg.id = p.id;
      if (p.retryMs !== undefined) msg.retryMs = p.retryMs;
      return msg;
    }
    if (line.startsWith(":")) return null; // comment line
    const m = FIELD_RE.exec(line);
    if (!m) return null; // malformed line: ignore
    const field = m[1];
    const value = m[2] ?? "";
    switch (field) {
      case "event":
        this.pending.event = value;
        break;
      case "id":
        // Per spec, id fields containing NUL must be ignored.
        if (!value.includes("\0")) this.pending.id = value;
        break;
      case "retry":
        this.pending.retryMs = Number(value);
        break;
      case "data":
        this.pending.data = this.pending.data === undefined ? value : `${this.pending.data}\n${value}`;
        break;
      default:
        break; // unknown fields are ignored
    }
    return null;
  }
}

/** Convenience wrapper: parse an entire SSE payload at once. */
export function parseSse(text: string): SseMessage[] {
  return new SseParser().push(text);
}
