import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INITIAL_REPLAY_CAP,
  MAX_RUN_EVENT_BYTES,
  MAX_RUN_LOG_TOTAL_BYTES,
  MAX_RUN_RETAINED_BYTES,
  appendRunEvent,
  flushRunLogs,
  readRunEvents,
  streamRunEventsFrom,
  tailRunLogLastSeq,
} from "./run-log";

function tmpRuns(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "b6-runlog-"));
}

function seed(dir: string, runId: string, count: number, maxBytes?: number): number {
  for (let i = 1; i <= count; i++) {
    appendRunEvent({ seq: i, runId, type: "log", data: i, ts: 0 }, dir, maxBytes);
  }
  return count;
}

async function drain(gen: AsyncGenerator<{ seq: number }>): Promise<Array<{ seq: number }>> {
  const out: Array<{ seq: number }> = [];
  for await (const event of gen) out.push(event);
  return out;
}

test("replays a legacy duplicate-seq log in write order", () => {
  const dir = tmpRuns();
  try {
    // Simulate the pre-fix corruption: seq restarts at 1 after an eviction,
    // so the durable log contains duplicates that must still replay in the
    // order they were appended, not grouped by seq.
    const writes: Array<[number, string]> = [
      [1, "a"],
      [2, "b"],
      [3, "c"],
      [1, "d"],
      [2, "e"],
    ];
    for (const [seq, tag] of writes) {
      appendRunEvent({ seq, runId: "run-1", type: "log", data: tag, ts: 0 }, dir);
    }
    const events = readRunEvents("run-1", dir);
    assert.deepEqual(
      events.map((e) => `${e.seq}:${e.data}`),
      ["1:a", "2:b", "3:c", "1:d", "2:e"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy duplicate-seq log replay ignores duplicate seqs", () => {
  const dir = tmpRuns();
  try {
    const writes: Array<[number, string]> = [
      [1, "a"],
      [2, "b"],
      [1, "c"],
    ];
    for (const [seq, tag] of writes) {
      appendRunEvent({ seq, runId: "run-1", type: "log", data: tag, ts: 0 }, dir);
    }
    const events = readRunEvents("run-1", dir);
    assert.deepEqual(events.map((e) => e.data), ["a", "b", "c"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tailRunLogLastSeq recovers the highest written seq", () => {
  const dir = tmpRuns();
  try {
    appendRunEvent({ seq: 1, runId: "run-1", type: "log", data: "a", ts: 0 }, dir);
    appendRunEvent({ seq: 2, runId: "run-1", type: "log", data: "b", ts: 0 }, dir);
    appendRunEvent({ seq: 3, runId: "run-1", type: "log", data: "c", ts: 0 }, dir);
    assert.equal(tailRunLogLastSeq("run-1", dir), 3);
    assert.equal(tailRunLogLastSeq("run-missing", dir), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tailRunLogLastSeq survives a torn trailing line", () => {
  const dir = tmpRuns();
  try {
    appendRunEvent({ seq: 1, runId: "run-1", type: "log", data: "a", ts: 0 }, dir);
    appendRunEvent({ seq: 2, runId: "run-1", type: "log", data: "b", ts: 0 }, dir);
    // Torn line (e.g. crash mid-append) must not hide the previous good seq.
    fs.appendFileSync(path.join(dir, "run-1.jsonl"), '{"runId":"run-1","seq":3,"type":"log","data":"c\"\n');
    assert.equal(tailRunLogLastSeq("run-1", dir), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function event(seq: number, data: string) {
  return { seq, runId: "run-1", type: "log", data, ts: 0 };
}

test("appending after a torn tail keeps the new event readable", (t) => {
  const dir = tmpRuns();
  const file = path.join(dir, "run-1.jsonl");
  try {
    t.mock.method(console, "warn", () => {});
    appendRunEvent(event(1, "a"), dir);
    appendRunEvent(event(2, "b"), dir);
    // Simulate a crash/force-exit mid-append: a partial line with no "\n".
    fs.appendFileSync(file, '{"runId":"run-1","seq":3,"type":"log"', "utf8");
    appendRunEvent(event(4, "d"), dir);

    const events = readRunEvents("run-1", dir);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 4]);
    assert.deepEqual(events.map((e) => e.data), ["a", "b", "d"]);

    // The torn line is terminated, not merged with seq 4, and every appended
    // event is a complete JSON line.
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[3]).seq, 4);
    assert.equal(tailRunLogLastSeq("run-1", dir), 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple torn writes each stay isolated from later appends", (t) => {
  const dir = tmpRuns();
  const file = path.join(dir, "run-1.jsonl");
  try {
    t.mock.method(console, "warn", () => {});
    appendRunEvent(event(1, "a"), dir);
    fs.appendFileSync(file, '{"torn":', "utf8");
    appendRunEvent(event(2, "b"), dir);
    fs.appendFileSync(file, '{"torn":', "utf8");
    appendRunEvent(event(4, "d"), dir);
    appendRunEvent(event(5, "e"), dir);

    const events = readRunEvents("run-1", dir);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 4, 5]);
    assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation freezes the torn segment on a line boundary", (t) => {
  const dir = tmpRuns();
  const file = path.join(dir, "run-1.jsonl");
  try {
    t.mock.method(console, "warn", () => {});
    const lineBytes = Buffer.byteLength(`${JSON.stringify(event(1, "a"))}\n`, "utf8");
    // One full line fits, a second one (plus the torn bytes) does not.
    const maxBytes = lineBytes + 8;
    appendRunEvent(event(1, "a"), dir, maxBytes);
    fs.appendFileSync(file, '{"torn":', "utf8");
    appendRunEvent(event(2, "b"), dir, maxBytes);

    const rotated = path.join(dir, "run-1.jsonl.1");
    assert.ok(fs.existsSync(rotated), "expected the torn segment to rotate");
    assert.ok(fs.readFileSync(rotated, "utf8").endsWith("\n"));
    assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
    assert.deepEqual(readRunEvents("run-1", dir).map((e) => e.seq), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seq ordering is intact across rotations with torn tails", (t) => {
  const dir = tmpRuns();
  const file = path.join(dir, "run-1.jsonl");
  try {
    t.mock.method(console, "warn", () => {});
    const maxBytes = 220;
    for (let seq = 1; seq <= 12; seq++) {
      appendRunEvent(event(seq, `event-${seq}`), dir, maxBytes);
      // Tear the active file on every third write.
      if (seq % 3 === 0) fs.appendFileSync(file, '{"torn":', "utf8");
    }
    const events = readRunEvents("run-1", dir);
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    assert.ok(fs.readdirSync(dir).some((name) => /^run-1\.jsonl\.\d+$/.test(name)));
    assert.equal(tailRunLogLastSeq("run-1", dir), 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reader warns once per segment about a torn line with its byte offset", (t) => {
  const dir = tmpRuns();
  const file = path.join(dir, "run-1.jsonl");
  try {
    const warn = t.mock.method(console, "warn", () => {});
    appendRunEvent(event(1, "a"), dir);
    const firstLine = `${JSON.stringify(event(1, "a"))}\n`;
    fs.appendFileSync(file, "not-json-1\nnot-json-2\n", "utf8");

    assert.deepEqual(readRunEvents("run-1", dir).map((e) => e.seq), [1]);
    assert.equal(warn.mock.calls.length, 1);
    const message = String(warn.mock.calls[0].arguments[0]);
    assert.match(message, /torn line/);
    assert.match(message, new RegExp(`byte offset ${Buffer.byteLength(firstLine, "utf8")}\\b`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("healthy appends do not introduce blank lines", () => {
  const dir = tmpRuns();
  try {
    for (let seq = 1; seq <= 3; seq++) appendRunEvent(event(seq, `e${seq}`), dir);
    const text = fs.readFileSync(path.join(dir, "run-1.jsonl"), "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 3);
    assert.ok(text.endsWith("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// b6: Last-Event-ID / since-cursor replay must be incremental and asynchronous.
// ---------------------------------------------------------------------------

test("reconnect with Last-Event-ID replays only newer events, in order", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-1", 10);
    const events = await drain(streamRunEventsFrom("run-1", dir, 4));
    assert.deepEqual(events.map((e) => e.seq), [5, 6, 7, 8, 9, 10]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay after a cursor has no duplicates or gaps", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-1", 100);
    const events = await drain(streamRunEventsFrom("run-1", dir, 37));
    const seqs = events.map((e) => e.seq);
    assert.equal(seqs.length, 63);
    assert.equal(new Set(seqs).size, 63, "no duplicate seqs");
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i] - seqs[i - 1], 1, "no gaps");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new viewer replay is capped to the most recent events", async () => {
  const dir = tmpRuns();
  try {
    const total = seed(dir, "run-1", 5000);
    const events = await drain(streamRunEventsFrom("run-1", dir, 0, { maxEvents: INITIAL_REPLAY_CAP }));
    assert.equal(events.length, INITIAL_REPLAY_CAP);
    assert.equal(events[0].seq, total - INITIAL_REPLAY_CAP + 1);
    assert.equal(events[events.length - 1].seq, total);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capped replay reports the omitted window through onWindow", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-1", 5000);
    let window: { truncated: boolean; firstSeq: number; lastSeq: number } | undefined;
    const events = await drain(
      streamRunEventsFrom("run-1", dir, 0, {
        maxEvents: INITIAL_REPLAY_CAP,
        onWindow: (info) => {
          window = info;
        },
      }),
    );
    assert.deepEqual(window, {
      truncated: true,
      firstSeq: 5000 - INITIAL_REPLAY_CAP + 1,
      lastSeq: 5000,
    });
    assert.equal(events[0].seq, 5000 - INITIAL_REPLAY_CAP + 1);
    assert.equal(events[events.length - 1].seq, 5000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("onWindow is not called when the whole log fits under the cap", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-1", 10);
    let called = false;
    const events = await drain(
      streamRunEventsFrom("run-1", dir, 0, {
        maxEvents: INITIAL_REPLAY_CAP,
        onWindow: () => {
          called = true;
        },
      }),
    );
    assert.equal(called, false);
    assert.equal(events.length, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconnect cursor skips events in older rotated segments", async () => {
  const dir = tmpRuns();
  try {
    // A small maxBytes forces a rotation roughly every few events.
    seed(dir, "run-1", 30, 200);
    const files = fs.readdirSync(dir);
    assert.ok(files.some((name) => /^run-1\.jsonl\.\d+$/.test(name)), "expected rotation");

    const events = await drain(streamRunEventsFrom("run-1", dir, 24));
    assert.deepEqual(events.map((e) => e.seq), [25, 26, 27, 28, 29, 30]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capped replay starts in the right rotated segment", async () => {
  const dir = tmpRuns();
  try {
    const total = seed(dir, "run-1", 50, 200);
    assert.ok(
      fs.readdirSync(dir).some((name) => /^run-1\.jsonl\.\d+$/.test(name)),
      "expected rotation",
    );

    const events = await drain(streamRunEventsFrom("run-1", dir, 0, { maxEvents: 10 }));
    assert.equal(events.length, 10);
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 10 }, (_, i) => total - 9 + i));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reading is asynchronous: the event loop is not blocked by a 20k log", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-big", 20_000);

    let immediateRanDuringStream = false;
    let finished = false;
    setImmediate(() => {
      immediateRanDuringStream = !finished;
    });

    let timerTicks = 0;
    const timer = setInterval(() => {
      timerTicks++;
    }, 1);

    // A zero-delay timer scheduled before the read must fire while events are
    // still streaming; a synchronous readFileSync + parse-all of the 20k-event
    // log would run it only after every event had been consumed.
    let seenAtTimer = -1;
    let seen = 0;
    setTimeout(() => {
      seenAtTimer = seen;
    }, 0);

    for await (const _event of streamRunEventsFrom("run-big", dir, 0)) {
      seen++;
    }
    finished = true;
    clearInterval(timer);

    assert.equal(seen, 20_000);
    // The setImmediate was scheduled before streaming and must have run while
    // the stream was still in flight.
    assert.equal(immediateRanDuringStream, true);
    assert.ok(timerTicks > 0, "timers fired during the asynchronous read");
    assert.ok(seenAtTimer >= 0, "the zero-delay timer fired during the read");
    assert.ok(seenAtTimer < seen, "the timer fired before replay finished");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: large events, empty active segments, and cursor + cap.
// ---------------------------------------------------------------------------

test("tail probe and replay survive events larger than the 64 KB probe window", async () => {
  const dir = tmpRuns();
  try {
    // A first line larger than the 4 KB head probe...
    const bigFirst = "a".repeat(8 * 1024);
    appendRunEvent({ seq: 1, runId: "run-1", type: "log", data: bigFirst, ts: 0 }, dir);
    appendRunEvent(event(2, "b"), dir);
    // ...and a last line larger than the 64 KB tail probe.
    const bigLast = "z".repeat(100 * 1024);
    appendRunEvent({ seq: 3, runId: "run-1", type: "log", data: bigLast, ts: 0 }, dir);

    // The tail probe must find the oversized last event, not report 0.
    assert.equal(tailRunLogLastSeq("run-1", dir), 3);
    // And replay must not skip the segment just because its probe range
    // could not be determined from a fixed-size window.
    const events = await drain(streamRunEventsFrom("run-1", dir, 0));
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.equal(readRunEvents("run-1", dir).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized events are truncated with a marker", () => {
  const dir = tmpRuns();
  try {
    const huge = "x".repeat(MAX_RUN_EVENT_BYTES * 2);
    appendRunEvent({ seq: 1, runId: "run-big", type: "log", data: huge, ts: 0 } as any, dir);
    const events = readRunEvents("run-big", dir);
    assert.equal(events.length, 1);
    assert.equal((events[0] as any).truncated, true);
    const line = fs.readFileSync(path.join(dir, "run-big.jsonl"), "utf8").trim();
    assert.ok(Buffer.byteLength(line, "utf8") <= MAX_RUN_EVENT_BYTES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tail probe finds the event before a giant torn tail", async () => {
  const dir = tmpRuns();
  try {
    appendRunEvent(event(1, "a"), dir);
    appendRunEvent(event(2, "b"), dir);
    // A torn tail larger than the probe window must not hide seq 2.
    fs.appendFileSync(path.join(dir, "run-1.jsonl"), `{"runId":"run-1","seq":3,"type":"log","data":"${"x".repeat(100 * 1024)}`, "utf8");
    assert.equal(tailRunLogLastSeq("run-1", dir), 2);
    const events = await drain(streamRunEventsFrom("run-1", dir, 0));
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retention limits remove old rotated segments", () => {
  const dir = tmpRuns();
  try {
    const maxBytes = 300;
    const perRunMax = 900;
    const globalMax = 50_000;
    for (let i = 1; i <= 40; i++) {
      appendRunEvent({ seq: i, runId: "run-ret", type: "log", data: "payload-" + i, ts: 0 } as any, dir, maxBytes, perRunMax, globalMax);
    }
    const files = fs.readdirSync(dir).filter((n) => n.startsWith("run-ret.jsonl"));
    let total = 0;
    for (const f of files) total += fs.statSync(path.join(dir, f)).size;
    assert.ok(total <= perRunMax + maxBytes, `total ${total} should be bounded`);
    const events = readRunEvents("run-ret", dir);
    assert.ok(events.length > 0);
    assert.equal(events[events.length - 1].seq, 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation during a read re-resolves ENOENT and drops no events", async (t) => {
  const dir = tmpRuns();
  try {
    const total = seed(dir, "run-race", 30, 220);
    const files = fs.readdirSync(dir);
    assert.ok(files.some((n) => /^run-race\.jsonl\.\d+$/.test(n)), "expected rotation");
    const original = fs.createReadStream;
    let injected = false;
    t.mock.method(fs, "createReadStream", ((p: fs.PathLike, opts?: any) => {
      const name = String(p);
      if (!injected && /run-race\.jsonl\.1$/.test(name)) {
        injected = true;
        const err = Object.assign(new Error("ENOENT injected"), { code: "ENOENT" });
        throw err;
      }
      return original(p as any, opts as any);
    }) as any);
    const events = await drain(streamRunEventsFrom("run-race", dir, 0));
    assert.equal(events.length, total);
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: total }, (_, i) => i + 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flushRunLogs drains pending writes on shutdown", async () => {
  const dir = tmpRuns();
  try {
    appendRunEvent({ seq: 1, runId: "run-flush", type: "log", data: "a", ts: 0 } as any, dir);
    appendRunEvent({ seq: 2, runId: "run-flush", type: "log", data: "b", ts: 0 } as any, dir);
    await flushRunLogs(dir);
    const events = readRunEvents("run-flush", dir);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capped replay after rotation reports the newest seq, not the empty active segment's 0", async () => {
  const dir = tmpRuns();
  try {
    // Simulate the state immediately after a rotation: a frozen segment
    // holding events 1-3 and an empty active file.
    const segment = [1, 2, 3]
      .map((seq) => `${JSON.stringify(event(seq, `e${seq}`))}\n`)
      .join("");
    fs.writeFileSync(path.join(dir, "run-1.jsonl.1"), segment);
    fs.writeFileSync(path.join(dir, "run-1.jsonl"), "");

    let window: { truncated: boolean; firstSeq: number; lastSeq: number } | undefined;
    const events = await drain(
      streamRunEventsFrom("run-1", dir, 0, {
        maxEvents: 2,
        onWindow: (info) => {
          window = info;
        },
      }),
    );
    assert.deepEqual(events.map((e) => e.seq), [2, 3]);
    assert.deepEqual(window, { truncated: true, firstSeq: 2, lastSeq: 3 });
    assert.equal(tailRunLogLastSeq("run-1", dir), 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capped replay with a cursor counts only events after the cursor", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-1", 10);
    // Six events sit after the cursor and the cap (8) covers all of them:
    // nothing after the cursor was omitted, so the replay is not truncated.
    let window: { truncated: boolean; firstSeq: number; lastSeq: number } | undefined;
    const all = await drain(
      streamRunEventsFrom("run-1", dir, 4, {
        maxEvents: 8,
        onWindow: (info) => {
          window = info;
        },
      }),
    );
    assert.deepEqual(all.map((e) => e.seq), [5, 6, 7, 8, 9, 10]);
    assert.equal(window, undefined);

    // With a tighter cap the newest events win and the window is reported.
    let window2: { truncated: boolean; firstSeq: number; lastSeq: number } | undefined;
    const capped = await drain(
      streamRunEventsFrom("run-1", dir, 4, {
        maxEvents: 4,
        onWindow: (info) => {
          window2 = info;
        },
      }),
    );
    assert.deepEqual(capped.map((e) => e.seq), [7, 8, 9, 10]);
    assert.deepEqual(window2, { truncated: true, firstSeq: 7, lastSeq: 10 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Record every fs.openSync(path, flags) call made while `fn` runs, then restore.
 * flushRunLogs is async (it drains the per-run write queues first), so the
 * patch must stay installed until the returned promise settles, or the fsync
 * opens happen after restore and are never recorded.
 */
async function recordOpenFlagsAsync(fn: () => Promise<void>): Promise<Array<{ file: string; flags: string }>> {
  const seen: Array<{ file: string; flags: string }> = [];
  const original = fs.openSync;
  (fs as { openSync: typeof fs.openSync }).openSync = ((p: fs.PathLike, flags?: string | number, mode?: number) => {
    seen.push({ file: String(p), flags: String(flags) });
    return (original as (p: fs.PathLike, flags?: string | number, mode?: number) => number)(p, flags, mode);
  }) as typeof fs.openSync;
  try {
    await fn();
  } finally {
    (fs as { openSync: typeof fs.openSync }).openSync = original;
  }
  return seen;
}

test("flushRunLogs opens segments r+ for cross-platform fsync and leaves them intact", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-1", 50, 200);
    const segments = fs
      .readdirSync(dir)
      .filter((name) => /^run-1\.jsonl(\.\d+)?$/.test(name))
      .sort();
    assert.ok(segments.length >= 2, `expected a base + rotated segment, got ${segments.join(", ")}`);
    const before = new Map(segments.map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));

    const opens = await recordOpenFlagsAsync(() => flushRunLogs(dir));

    // Every segment must be attempted with "r+" first: on Windows, fsync on
    // a read-only handle fails, so "r" alone is not fsync-safe there.
    for (const name of segments) {
      const file = path.join(dir, name);
      const attempts = opens.filter((o) => o.file === file).map((o) => o.flags);
      assert.deepEqual(attempts, ["r+"], `${name} should be opened r+ (got ${attempts.join(", ")})`);
      assert.equal(fs.readFileSync(file, "utf8"), before.get(name), `${name} must be byte-identical after flush`);
    }
    // No segment may be left open by the flush.
    assert.equal(readRunEvents("run-1", dir).length, 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flushRunLogs falls back to r when a segment cannot be opened r+", async () => {
  const dir = tmpRuns();
  try {
    // A directory whose name matches a log segment cannot be opened "r+"
    // (EISDIR) on any platform, so it deterministically exercises the "r"
    // fallback — the same path a frozen read-only segment takes on Windows.
    const dirSegment = path.join(dir, "run-1.jsonl");
    fs.mkdirSync(dirSegment);
    seed(dir, "run-2", 3);

    const opens = await recordOpenFlagsAsync(() => flushRunLogs(dir));

    const attempts = opens.filter((o) => o.file === dirSegment).map((o) => o.flags);
    assert.deepEqual(attempts, ["r+", "r"], `directory segment should fall back r+ -> r (got ${attempts.join(", ")})`);
    assert.equal(readRunEvents("run-2", dir).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flushRunLogs tolerates a read-only segment and missing dirs", async () => {
  const dir = tmpRuns();
  try {
    seed(dir, "run-1", 5);
    const file = path.join(dir, "run-1.jsonl");
    const before = fs.readFileSync(file, "utf8");
    fs.chmodSync(file, 0o444);
    try {
      // Must not throw even where "r+" is refused for the read-only segment.
      await flushRunLogs(dir);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(readRunEvents("run-1", dir).length, 5);

    await flushRunLogs(null);
    await flushRunLogs(path.join(dir, "does-not-exist"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});