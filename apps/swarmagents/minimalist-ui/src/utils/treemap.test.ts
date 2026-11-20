import test from "node:test";
import assert from "node:assert/strict";
import { squarifiedTreemap } from "./treemap";

test("squarifiedTreemap lays every entry out inside the box", () => {
  const rects = squarifiedTreemap(
    [
      { path: "a.ts", value: 40 },
      { path: "b.ts", value: 30 },
      { path: "c.ts", value: 20 },
      { path: "d.ts", value: 10 },
    ],
    400,
    200,
  );
  assert.equal(rects.length, 4);
  for (const rect of rects) {
    assert.ok(rect.x >= -1e-6, `${rect.path} x`);
    assert.ok(rect.y >= -1e-6, `${rect.path} y`);
    assert.ok(rect.x + rect.width <= 400 + 1e-6, `${rect.path} right`);
    assert.ok(rect.y + rect.height <= 200 + 1e-6, `${rect.path} bottom`);
    assert.ok(rect.width > 0 && rect.height > 0, `${rect.path} size`);
  }
});

test("squarifiedTreemap keeps the rectangles inside each other (no overlap)", () => {
  const rects = squarifiedTreemap(
    [
      { path: "a.ts", value: 9 },
      { path: "b.ts", value: 5 },
      { path: "c.ts", value: 4 },
      { path: "d.ts", value: 2 },
      { path: "e.ts", value: 1 },
    ],
    300,
    300,
  );
  const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  assert.ok(Math.abs(area - 300 * 300) < 1e-3, `area ${area}`);

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const overlap = Math.max(0, overlapX) * Math.max(0, overlapY);
      assert.ok(overlap < 1e-3, `${a.path} overlaps ${b.path} by ${overlap}`);
    }
  }
});

test("squarifiedTreemap drops entries without a value", () => {
  const rects = squarifiedTreemap(
    [
      { path: "a.ts", value: 1 },
      { path: "b.ts", value: 0 },
      { path: "c.ts", value: Number.NaN },
    ],
    100,
    100,
  );
  assert.deepEqual(rects.map((rect) => rect.path), ["a.ts"]);
});

test("squarifiedTreemap handles a portrait box", () => {
  const rects = squarifiedTreemap(
    [
      { path: "a.ts", value: 3 },
      { path: "b.ts", value: 2 },
      { path: "c.ts", value: 1 },
    ],
    120,
    400,
  );
  assert.equal(rects.length, 3);
  for (const rect of rects) {
    assert.ok(rect.x + rect.width <= 120 + 1e-6);
    assert.ok(rect.y + rect.height <= 400 + 1e-6);
  }
});
