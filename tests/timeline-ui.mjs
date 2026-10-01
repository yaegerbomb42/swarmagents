// Timeline pure-function tests: run with `node tests/timeline-ui.mjs` (no server boot needed).
// Mirrors checkpoints()/splitDiff()/lineDiff() in components/Timeline.tsx.
import assert from "node:assert";

function checkpoints(output) {
  const out = [];
  for (const m of output.matchAll(/\[checkpoint ([a-f0-9]+) path=([^\]]+)\]/g)) out.push({ id: m[1], path: m[2] });
  return out;
}
function splitDiff(output) {
  const lines = output.split("\n");
  const oldIdx = lines.findIndex((l) => l.trim() === "--- old" || l.startsWith("--- before"));
  if (oldIdx < 0) return null;
  const plusIdx = lines.findIndex((l, i) => i > oldIdx && (l.trim() === "+++ new" || l.startsWith("+++ after")));
  if (plusIdx < 0) return null;
  return {
    head: lines.slice(0, oldIdx).filter((l) => !l.startsWith("[checkpoint ")).join("\n").trim(),
    oldText: lines.slice(oldIdx + 1, plusIdx).join("\n"),
    newText: lines.slice(plusIdx + 1).join("\n"),
  };
}

// 1. write_file output parses: marker stripped from head, before/after split
{
  const sample = "Overwrote /tmp/a.txt (2 lines)\n[checkpoint abc123 path=/tmp/a.txt]\n--- old\nhello world\n+++ new\nhello brave new world\nline2";
  const d = splitDiff(sample);
  assert.equal(d.head, "Overwrote /tmp/a.txt (2 lines)");
  assert.equal(d.oldText, "hello world");
  assert.equal(d.newText, "hello brave new world\nline2");
  assert.deepEqual(checkpoints(sample), [{ id: "abc123", path: "/tmp/a.txt" }]);
}
// 2. before/after variant (write_file overwrite path)
{
  const sample = "Overwrote /tmp/b.txt (1 lines)\n[checkpoint def456 path=/tmp/b.txt]\n--- before (first 4k)---\nold stuff\n+++ after (first 4k) +++\nnew stuff";
  const d = splitDiff(sample);
  assert.ok(d && d.oldText.includes("old stuff") && d.newText.includes("new stuff"));
}
// 3. plain outputs fall through to <pre> (null diff, no markers)
{
  assert.equal(splitDiff("plain output no markers"), null);
  assert.deepEqual(checkpoints("plain output"), []);
}
// 4. checkpoint id is hex-only (matches restore route validation)
{
  assert.deepEqual(checkpoints("[checkpoint ../evil path=/x]"), []);
  assert.deepEqual(checkpoints("[checkpoint ABCXYZ path=/x]"), []);
}
console.log("timeline-ui: 4/4 pass");
