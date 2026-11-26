import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEffectLine } from "./effect";

describe("parseEffectLine", () => {
  it("parses the exact changed-with-focus format from effect.mjs", () => {
    assert.deepEqual(parseEffectLine('effect: screen changed near (10, 20); focus moved to "Save As"'), {
      changed: true,
      focus: "Save As",
    });
    assert.deepEqual(parseEffectLine('effect: screen changed; focus moved to "9"'), {
      changed: true,
      focus: "9",
    });
  });

  it("parses the exact no-change format with real elapsed seconds", () => {
    assert.deepEqual(parseEffectLine("effect: NO visible change after 1.5s; focused window unchanged"), {
      changed: false,
      elapsedS: 1.5,
    });
    assert.deepEqual(
      parseEffectLine("effect: NO visible change near (640, 420) after 2.0s; focused window unchanged"),
      { changed: false, elapsedS: 2 },
    );
  });

  it("recognizes a change without a focus move", () => {
    assert.deepEqual(parseEffectLine("effect: screen changed"), { changed: true });
    assert.deepEqual(parseEffectLine('effect: screen changed near (10, 20); window title now "Editor"'), {
      changed: true,
    });
  });

  it("finds the effect line anywhere in a multi-line tool result", () => {
    const output = [
      "Clicked at (640, 420)",
      "",
      'element: button.save"',
      "effect: NO visible change after 1.5s; focused window unchanged",
    ].join("\n");
    assert.deepEqual(parseEffectLine(output), { changed: false, elapsedS: 1.5 });
  });

  it("returns null for output without an effect line", () => {
    assert.equal(parseEffectLine("all good here"), null);
    assert.equal(parseEffectLine(""), null);
    assert.equal(parseEffectLine("hint: your last few actions changed nothing on screen"), null);
    assert.equal(parseEffectLine("effect: something unfamiliar"), null);
    assert.equal(parseEffectLine(undefined as unknown as string), null);
    assert.equal(parseEffectLine(null as unknown as string), null);
  });
});
