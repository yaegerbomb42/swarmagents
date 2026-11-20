import assert from "node:assert/strict";
import test from "node:test";
import { presetModelCapabilities } from "../providers/capabilities";
import {
  executeComputer,
  modelHasVision,
  observationPrompt,
  observationTool,
  validateComputerCall,
  type ComputerHost,
} from "./computer";

const bounds = { width: 1280, height: 800 };

test("Mercury-class text models observe with describe_screen", () => {
  const caps = presetModelCapabilities("mercury", "mercury-3");
  assert.equal(modelHasVision(caps), false);
  assert.equal(observationTool(false), "describe_screen");
  assert.match(observationPrompt(false), /describe_screen/);
  const shot = validateComputerCall({ action: "screenshot" }, bounds, false);
  assert.equal(shot.ok, false);
});

test("vision models may screenshot and click in bounds", () => {
  const caps = presetModelCapabilities("anthropic", "claude-sonnet-4");
  assert.equal(modelHasVision(caps), true);
  assert.equal(observationTool(true), "screenshot");
  assert.equal(validateComputerCall({ action: "click", x: 10, y: 20 }, bounds, true).ok, true);
  assert.equal(validateComputerCall({ action: "click", x: 9000, y: 1 }, bounds, true).ok, false);
  assert.equal(validateComputerCall({ action: "type", text: "x".repeat(2001) }, bounds, true).ok, false);
  assert.equal(validateComputerCall({ action: "open_app", app: "shell" }, bounds, true).ok, false);
  assert.equal(validateComputerCall({ action: "read_file", path: "/etc/passwd" }, bounds, true).ok, false);
});

test("executeComputer returns a tree for text models and pixels for vision", async () => {
  const host: ComputerHost = {
    bounds,
    async screenshot() {
      return { bytes: 12 };
    },
    async describeScreen() {
      return [{ id: "ok", role: "button", label: "Save", x: 1, y: 2, width: 10, height: 10 }];
    },
    async act() {
      return "acted";
    },
  };
  const tree = await executeComputer(host, { action: "describe_screen" }, false);
  assert.equal(tree.ok, true);
  assert.equal(tree.nodes?.[0]?.id, "ok");
  const pixels = await executeComputer(host, { action: "screenshot" }, true);
  assert.equal(pixels.output, "screenshot:12");
  const click = await executeComputer(host, { action: "click", elementId: "ok" }, false);
  assert.equal(click.output, "acted");
  const bad = await executeComputer(host, { action: "press_key", key: "rm -rf" }, false);
  assert.equal(bad.ok, false);
});
