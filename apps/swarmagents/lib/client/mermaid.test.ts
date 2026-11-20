import test from "node:test";
import assert from "node:assert/strict";
import { layoutMermaid, normalizeArrow, parseMermaid, parseNodeToken } from "./mermaid";

test("parses a mermaid node reference", () => {
  assert.deepEqual(parseNodeToken("A"), { id: "A" });
  assert.deepEqual(parseNodeToken("A[Browser]"), { id: "A", label: "Browser", shape: "rect" });
  assert.deepEqual(parseNodeToken('A["Web App"]'), { id: "A", label: "Web App", shape: "rect" });
  assert.deepEqual(parseNodeToken("B((Worker))"), { id: "B", label: "Worker", shape: "circle" });
  assert.deepEqual(parseNodeToken("C{Choice}"), { id: "C", label: "Choice", shape: "diamond" });
  assert.deepEqual(parseNodeToken("D[(Database)]"), { id: "D", label: "Database", shape: "cylinder" });
  assert.equal(parseNodeToken(""), null);
});

test("normalises the arrow spellings mermaid accepts", () => {
  assert.equal(normalizeArrow("A --> B"), "A --> B");
  assert.equal(normalizeArrow("A -.-> B"), "A --> B");
  assert.equal(normalizeArrow("A ==> B"), "A --> B");
  assert.equal(normalizeArrow("A -- calls --> B"), "A -->|calls| B");
});

test("parses a flowchart into nodes and edges", () => {
  const graph = parseMermaid(`flowchart TD
    A[Browser] -->|sends| B[API]
    B --> C[(Database)]
    C -.-> D[Cache]
    E[Worker] & F[Queue] ==> G[Store]`);
  assert.ok(graph);
  assert.equal(graph.direction, "TB");
  const ids = graph.nodes.map((node) => node.id).sort();
  assert.deepEqual(ids, ["A", "B", "C", "D", "E", "F", "G"]);
  const browser = graph.nodes.find((node) => node.id === "A");
  assert.equal(browser?.label, "Browser");
  const database = graph.nodes.find((node) => node.id === "C");
  assert.equal(database?.shape, "cylinder");

  const edge = graph.edges.find((e) => e.from === "A" && e.to === "B");
  assert.equal(edge?.label, "sends");
  assert.equal(graph.edges.find((e) => e.from === "C" && e.to === "D")?.dashed, true);
  assert.equal(graph.edges.find((e) => e.from === "E" && e.to === "G")?.thick, true);
  assert.equal(graph.edges.filter((e) => e.to === "G").length, 2);
});

test("ignores diagrams it cannot draw", () => {
  assert.equal(parseMermaid("just some prose"), null);
  assert.equal(parseMermaid(""), null);
  assert.equal(parseMermaid("sequenceDiagram\n  A->>B: hi"), null);
});

test("lays the graph out in layers", () => {
  const graph = parseMermaid(`flowchart TD
    A[Browser] --> B[API]
    B --> C[(Database)]
    A --> C`);
  assert.ok(graph);
  const layout = layoutMermaid(graph);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const browser = byId.get("A");
  const api = byId.get("B");
  const database = byId.get("C");
  assert.ok(browser && api && database);
  // The database is two levels deep, the API one, the browser none.
  assert.ok(api!.y > browser!.y, "the API sits below the browser");
  assert.ok(database!.y > api!.y, "the database sits below the API");
  assert.ok(layout.width > 0 && layout.height > 0);
  assert.equal(layout.edges.length, 3);
  for (const edge of layout.edges) {
    assert.equal(edge.points.length, 2);
  }
});

test("lays a left-to-right diagram out in columns", () => {
  const graph = parseMermaid(`flowchart LR
    A[Browser] --> B[API]`);
  assert.ok(graph);
  assert.equal(graph.direction, "LR");
  const layout = layoutMermaid(graph);
  const browser = layout.nodes.find((node) => node.id === "A");
  const api = layout.nodes.find((node) => node.id === "B");
  assert.ok(browser && api);
  assert.ok(api!.x > browser!.x, "the API sits to the right of the browser");
});
