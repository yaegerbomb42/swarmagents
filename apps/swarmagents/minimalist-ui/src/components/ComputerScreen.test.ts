/**
 * Component tests for the humanized terminal (Frontier Piece 4): the
 * terminal shows a one-line summary per tool event, raw JSON only behind a
 * collapsed Details disclosure, no model string, and no internal kind
 * vocabulary. Static renders (see testing/harness.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import type { RunStreamItem } from "../../../lib/client/useRunStream";

const h = React.createElement;

/** Components are imported after the browser stubs are in place. */
async function load() {
  installBrowserStubs();
  return import("./ComputerScreen");
}

function item(seq: number, kind: string, data: unknown): RunStreamItem {
  return { seq, kind, data, parsed: { data: "" }, ts: 0 };
}

/** The markup before the first <details>: the visible summary line only. */
function headOf(markup: string): string {
  const idx = markup.indexOf("<details");
  return idx === -1 ? markup : markup.slice(0, idx);
}

test("tool.call Write shows the path once, with raw JSON only inside Details", async () => {
  const { StreamRow } = await load();
  const it = item(1, "tool.call", {
    name: "Write",
    input: { file_path: "/workspace/hello.txt", content: "Hello\nworld" },
    id: "1",
  });
  const markup = renderToStaticMarkup(h(StreamRow, { item: it }));
  const head = headOf(markup);
  assert.equal((head.match(/\/workspace\/hello\.txt/g) ?? []).length, 1, "path appears once in the summary line");
  assert.ok(!head.includes("{"), "no JSON object in the summary line");
  assert.ok(!head.includes("file_path"), "no raw input key in the summary line");
  assert.ok(!head.includes("\\n"), "no escaped newline in the summary line");
  assert.ok(markup.includes("<details"), "raw JSON is behind a Details disclosure");
  assert.ok(markup.includes("file_path"), "the redacted JSON is inside Details");
});

test("tool.call Bash shows the command, no JSON", async () => {
  const { StreamRow } = await load();
  const it = item(2, "tool.call", {
    name: "Bash",
    input: { command: "python3 /workspace/fib.py" },
    id: "2",
  });
  const markup = renderToStaticMarkup(h(StreamRow, { item: it }));
  const head = headOf(markup);
  assert.match(head, /python3 \/workspace\/fib\.py/);
  assert.ok(!head.includes("{"), "no JSON in the summary line");
  assert.ok(!head.includes("command"), "no raw input key in the summary line");
});

test("tool.result shows ok, the first line and a byte count; the rest is inside Details", async () => {
  const { StreamRow } = await load();
  const output = "line one\nline two\nline three";
  const it = item(3, "tool.result", { ok: true, output });
  const markup = renderToStaticMarkup(h(StreamRow, { item: it }));
  const head = headOf(markup);
  assert.match(head, /\bok\b/);
  assert.match(head, /line one/);
  assert.ok(!head.includes("line two"), "later lines stay behind Details");
  const bytes = new TextEncoder().encode(output).length;
  assert.ok(head.includes(`${bytes} B`), "byte count shown");
  assert.ok(markup.includes("line three"), "full output is inside Details");
});

test("run.started shows no model string when none is provided", async () => {
  const { StreamRow } = await load();
  const it = item(4, "run.started", { sessionId: "s1" });
  const markup = renderToStaticMarkup(h(StreamRow, { item: it }));
  assert.match(markup, /run started/);
  assert.ok(!markup.includes("claude"), "no model fallback either");
});

test("run.started shows provider and model when present", async () => {
  const { StreamRow } = await load();
  const it = item(4, "run.started", { sessionId: "s1", provider: "groq", model: "llama-3.3-70b" });
  const markup = renderToStaticMarkup(h(StreamRow, { item: it }));
  assert.match(markup, /run started · groq · llama-3.3-70b/);
});

test("internal kinds render human labels, never the raw kind", async () => {
  const { StreamRow } = await load();
  const route = renderToStaticMarkup(h(StreamRow, { item: item(5, "route.decision", { decision: "x" }) }));
  assert.match(route, /routing decision/);
  assert.ok(!route.includes("route.decision"), "raw kind never rendered");
  const llm = renderToStaticMarkup(h(StreamRow, { item: item(6, "llm.call", {}) }));
  assert.match(llm, /model call/);
  assert.ok(!llm.includes("llm.call"), "raw kind never rendered");
});

test("the terminal header has no extra environment banner", async () => {
  const { ComputerScreen } = await load();
  const markup = renderToStaticMarkup(
    h(ComputerScreen, {
      logs: [],
      activeView: "terminal",
      onToggleView: () => {},
      onResetVm: () => {},
      vmResetting: false,
      activeRoleName: "test",
    }),
  );
  assert.ok(!markup.includes("Isolated User Sandbox"), "no environment banner is rendered");
});

test("computer startup status uses plain words", async () => {
  const { StreamRow } = await load();
  const markup = renderToStaticMarkup(h(StreamRow, { item: item(7, "vm.starting", {}) }));
  assert.match(markup, /Starting a separate Linux computer for this run/);
  assert.ok(!markup.includes("sandbox"));
});

test("log events render their text as a muted system line, never raw JSON", async () => {
  const { StreamRow } = await load();
  // Mirrors the SSE shape: the parsed data is the whole sequenced event.
  const it = item(8, "log", {
    type: "log",
    data: "oracle: 1/2 candidates rejected; nothing landed",
    seq: 8,
    runId: "run_oracle",
    ts: 0,
  });
  const markup = renderToStaticMarkup(h(StreamRow, { item: it }));
  const head = headOf(markup);
  assert.ok(head.includes("oracle: 1/2 candidates rejected; nothing landed"), "oracle line is visible");
  assert.ok(!head.includes("run_oracle"), "no internal identifiers in the visible line");
  assert.ok(!head.includes("{"), "no JSON object in the visible line");
});

test("provider.pool failover renders the new provider + model (bus-wrapped event)", async () => {
  const { StreamRow } = await load();
  const it = item(5, "provider.pool", { type: "provider.pool", data: { type: "pool.attempt", provider: "openrouter", model: "deepseek-v3", reason: "failover" } });
  const markup = renderToStaticMarkup(h(StreamRow, { item: it }));
  assert.match(markup, /→ openrouter · deepseek-v3 \(failover\)/);
});
