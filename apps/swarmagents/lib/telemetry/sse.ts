import { telemetryBus, type SequencedEvent, type TelemetryBus, type TelemetryListener } from "./bus";
import { getRunsDir } from "./paths";
import { INITIAL_REPLAY_CAP, streamRunEventsFrom, tailRunLogLastEvent } from "./run-log";

export function encodeSse(event: SequencedEvent): string {
  const safeSeq = String(event.seq).replace(/[\r\n]/g, "");
  const safeType = String(event.type).replace(/[\r\n]/g, "");
  // Synthetic frames (stream.error seq -1, run.snapshot seq 0) must not carry
  // an id: EventSource would persist it as Last-Event-ID and replay the whole
  // run on the next reconnect. Real events start at seq 1.
  const id = event.seq > 0 ? `id: ${safeSeq}\n` : "";
  return `${id}event: ${safeType}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Run events after which no further events can arrive for a run. */
export function isTerminalRunEvent(type: string): boolean {
  return type === "run.finished" || type === "run.error" || type === "run.cancelled";
}

export interface SseStreamOptions {
  bus?: TelemetryBus;
  keepAliveMs?: number;
  /**
   * Runs dir for durable replay of events the in-memory bus no longer holds
   * (buffer eviction or a process restart). `null` disables log replay;
   * undefined resolves the live runs dir.
   */
  runsDir?: string | null;
}

export function sseResponse(
  runId: string,
  fromSeq: number,
  signal: AbortSignal,
  options: SseStreamOptions = {},
): ReadableStream<Uint8Array> {
  const bus = options.bus ?? telemetryBus;
  const keepAliveMs = Math.max(0, options.keepAliveMs ?? 15_000);
  const encoder = new TextEncoder();
  // Diagnostic logging behind SWARM_SSE_DEBUG (off by default) so the stream's
  // lifecycle — setup, terminal close, abort handling — can be inspected on a
  // box where the run is flaking without adding hot-path overhead otherwise.
  const debug = Boolean(process.env.SWARM_SSE_DEBUG);
  const dbg = (...args: unknown[]): void => {
    if (debug) console.error("[telemetry:sse]", runId, ...args);
  };
  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let terminalSent = false;
      let unsubscribe: (() => void) | null = null;
      let pendingUnsubscribe = false;
      let onAbort: (() => void) | null = null;
      const abortAtSetup = signal.aborted;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const closeStream = (why: string) => {
        if (closed) return;
        closed = true;
        dbg("close", why);
        if (keepAlive !== undefined) clearInterval(keepAlive);
        // Long-lived AbortSignals (e.g. the request's) outlive a closed stream;
        // detaching here prevents an ever-growing chain of closed-over frames.
        if (onAbort) {
          signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
        if (unsubscribe) unsubscribe();
        else pendingUnsubscribe = true;
        try {
          controller.close();
        } catch {}
      };

      // Send one event; a terminal event ends the run, so close the stream
      // right after delivering it. Clients then know not to reconnect.
      const send = (event: SequencedEvent) => {
        safeEnqueue(encodeSse(event));
        if (isTerminalRunEvent(event.type)) {
          terminalSent = true;
          closeStream("terminal");
        }
      };

      // Emit an explicit error frame, then close. This is the only other way a
      // stream ever closes: a client must never see a silent, empty close when
      // the underlying connection aborts before the run reached a terminal
      // state.
      const errorClose = (message: string) => {
        dbg("error-close", message);
        safeEnqueue(
          encodeSse({ seq: -1, runId, type: "stream.error", data: { message }, ts: Date.now() }),
        );
        closeStream("stream.error");
      };

      cleanup = () => closeStream("cancel");

      // keepAliveMs: 0 is used by tests and means "no timer": a 0 ms interval
      // would otherwise spin and flood the stream with keep-alive frames.
      const keepAlive = keepAliveMs > 0 ? setInterval(() => safeEnqueue(": keep-alive\n\n"), keepAliveMs) : undefined;
      keepAlive?.unref?.();

      // Replay newer events from the durable run log asynchronously. The log
      // survives buffer eviction and restarts, so it is the only copy of an
      // idle run's events; a terminal event in it must still close the stream
      // (otherwise a fresh connect to a finished/cancelled run hangs on
      // keep-alives forever). A new viewer gets a capped replay; a reconnect
      // (fromSeq > 0) streams everything newer than its Last-Event-ID and
      // skips segments wholly behind that cursor. Streaming never reads or
      // parses the whole log synchronously.
      //
      // Subscribe immediately so no live event is missed between stream
      // creation and the async replay completing. Events are buffered in
      // `pending` (deduped by content) until replay finishes, then flushed in
      // seq order. After replay, live events are forwarded straight through —
      // mirroring the bus's live semantics (no fromSeq filtering on live events).
      const dir = options.runsDir === undefined ? getRunsDir() : options.runsDir;
      const maxReplay = fromSeq > 0 ? Infinity : INITIAL_REPLAY_CAP;
      // Key on the whole event, not just seq: legacy disk logs can contain
      // distinct events sharing a seq number, and keying by seq alone would
      // silently drop them. Identical events appearing in both the log and
      // the bus buffer still dedupe to a single frame.
      const pending = new Map<string, SequencedEvent>();
      const pendingKey = (event: SequencedEvent) => {
        try {
          return `${event.seq}\u0000${JSON.stringify(event)}`;
        } catch {
          // A non-JSON-safe payload must still be deliverable; fall back to
          // the identity fields rather than dropping the event entirely.
          return `${event.seq}\u0000${event.ts}\u0000${event.type}`;
        }
      };
      const buffer = (event: SequencedEvent) => {
        const key = pendingKey(event);
        if (!pending.has(key)) pending.set(key, event);
      };
      let replayDone = false;
      // A new viewer only receives the capped tail. Announce the window up
      // front (seq 0 sorts before every real event) so the client knows the
      // head of the run was omitted instead of silently starting mid-run.
      const noteReplayWindow = (info: { truncated: boolean; firstSeq: number; lastSeq: number }) => {
        if (!info.truncated || fromSeq > 0) return;
        buffer({
          seq: 0,
          runId,
          ts: Date.now(),
          type: "run.snapshot",
          data: {
            truncated: true,
            firstEventId: info.firstSeq,
            lastEventId: info.lastSeq,
          },
        });
      };
      const listener: TelemetryListener = (event) => {
        if (closed) return;
        if (replayDone) {
          send(event);
          return;
        }
        buffer(event);
      };
      unsubscribe = bus.subscribe(runId, fromSeq, listener);
      // A terminal event may have buffered the bus replay before subscribe()
      // returned its unsubscribe function.
      if (pendingUnsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      // A mid-stream abort is a genuine client disconnect: the client has
      // already received events and initiated the abort itself, so closing
      // quietly just releases the subscription. Attach before the async
      // replay so a disconnect during replay stops the read promptly.
      if (!abortAtSetup) {
        onAbort = () => closeStream("abort");
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Abort that fires before the stream ever delivered data (the signal is
      // already aborted when setup runs) is the spurious race this guard is
      // for: a fresh connect that raced an abort must not present itself as an
      // empty, finished stream. Never close silently here — if the run has in
      // fact finished (a terminal event sits at the end of the durable log),
      // re-send/keep it so a client that lost the tail sees a clean close; if
      // the run is still running, emit an explicit stream.error instead of
      // truncating silently.
      const finishSetupAbort = () => {
        if (closed) return;
        if (terminalSent) {
          closeStream("abort-after-terminal");
          return;
        }
        if (dir) {
          const last = tailRunLogLastEvent(runId, dir);
          if (last && isTerminalRunEvent(last.type)) {
            if (last.seq <= fromSeq) {
              // The client already saw this terminal; close quietly.
              closeStream("abort-terminal-already-seen");
              return;
            }
            // The replay should normally have delivered it; guard against a
            // racing torn tail by delivering the terminal we just found.
            dbg("abort replayed terminal", last.type, last.seq);
            send(last);
            return;
          }
        }
        errorClose("SSE connection aborted before the run reached a terminal state");
      };

      void (async () => {
        if (dir) {
          try {
            for await (const event of streamRunEventsFrom(runId, dir, fromSeq, {
              maxEvents: maxReplay,
              onWindow: noteReplayWindow,
            })) {
              if (closed) break;
              buffer(event);
            }
          } catch (err) {
            console.error(`[telemetry] log replay failed for ${runId}:`, err);
          }
        }

        if (closed) return;
        replayDone = true;
        // Reconnect gap: the client's cursor predates the oldest event
        // still available (bus eviction plus log rotation/pruning). The
        // events between the cursor and the replay window are gone for
        // good — say so up front with a run.snapshot instead of silently
        // starting mid-run. A fresh connect (fromSeq 0) already gets its
        // truncated-window snapshot from noteReplayWindow; this covers
        // the reconnect case, where the cap is unbounded.
        if (fromSeq > 0 && pending.size > 0) {
          let firstSeq = Infinity;
          let lastSeq = 0;
          for (const event of pending.values()) {
            if (event.seq > 0) {
              firstSeq = Math.min(firstSeq, event.seq);
              lastSeq = Math.max(lastSeq, event.seq);
            }
          }
          if (firstSeq > fromSeq + 1) {
            buffer({
              seq: 0,
              runId,
              ts: Date.now(),
              type: "run.snapshot",
              data: {
                truncated: true,
                gap: true,
                resumedFrom: fromSeq,
                firstEventId: firstSeq,
                lastEventId: lastSeq,
              },
            });
          }
        }
        const ordered = [...pending.values()].sort((a, b) => a.seq - b.seq);
        for (const event of ordered) {
          send(event);
          if (closed) break;
        }
        // The replay buffer can hold thousands of events; drop the references
        // once flushed so they are not retained for the live part of the stream.
        pending.clear();
        if (closed) return;
        if (abortAtSetup) finishSetupAbort();
      })();
    },
    cancel() {
      cleanup();
    },
  });
}
