/**
 * One computer-use surface for vision and text-only models.
 * Observation differs (pixels vs an accessibility tree). Actions are the same
 * and fail closed on bad coordinates, oversized text, or unknown apps.
 */

import type { ModelCapabilities } from "../providers/types";

export const COMPUTER_ACTIONS = [
  "click",
  "type",
  "press_key",
  "scroll",
  "open_app",
  "read_file",
  "write_file",
  "run_terminal",
  "list_windows",
] as const;

export type ComputerActionName = (typeof COMPUTER_ACTIONS)[number];

export const OPEN_APPS = ["browser", "terminal", "files"] as const;

const MAX_TEXT = 2000;
const MAX_PATH = 512;
const MAX_CMD = 4000;
const KEY_RE = /^[A-Za-z0-9_+\-]+$/;

export interface ScreenBounds {
  width: number;
  height: number;
}

export interface A11yNode {
  id: string;
  role: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ComputerCall =
  | { action: "screenshot" }
  | { action: "describe_screen" }
  | {
      action: ComputerActionName;
      x?: number;
      y?: number;
      elementId?: string;
      text?: string;
      key?: string;
      direction?: "up" | "down" | "left" | "right";
      amount?: number;
      app?: string;
      path?: string;
      command?: string;
    };

export interface ComputerResult {
  ok: boolean;
  error?: string;
  observation?: "screenshot" | "describe_screen";
  nodes?: A11yNode[];
  output?: string;
}

export interface ComputerHost {
  bounds: ScreenBounds;
  screenshot(): Promise<{ bytes: number }>;
  describeScreen(): Promise<A11yNode[]>;
  act(call: Extract<ComputerCall, { action: ComputerActionName }>): Promise<string>;
}

/** Vision models see the screen. Text-only models (Mercury 3) get the tree. */
export function modelHasVision(caps: Pick<ModelCapabilities, "vision"> | undefined): boolean {
  return caps?.vision === true;
}

export function observationTool(vision: boolean): "screenshot" | "describe_screen" {
  return vision ? "screenshot" : "describe_screen";
}

export function observationPrompt(vision: boolean): string {
  return vision
    ? "This model has vision. Observe the desktop with screenshot, then click, type, press_key, or scroll using coordinates."
    : "This model has no vision. Observe the desktop with describe_screen (element id, role, label, bounds), then act by elementId.";
}

function intIn(value: unknown, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

export function validateComputerCall(raw: unknown, bounds: ScreenBounds, vision: boolean): { ok: true; call: ComputerCall } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "computer call must be an object" };
  const input = raw as Record<string, unknown>;
  const action = typeof input.action === "string" ? input.action : "";
  if (action === "screenshot") {
    if (!vision) return { ok: false, error: "screenshot requires a vision model; use describe_screen" };
    return { ok: true, call: { action: "screenshot" } };
  }
  if (action === "describe_screen") return { ok: true, call: { action: "describe_screen" } };
  if (!COMPUTER_ACTIONS.includes(action as ComputerActionName)) return { ok: false, error: `unknown computer action: ${action || "(missing)"}` };

  const call: Extract<ComputerCall, { action: ComputerActionName }> = { action: action as ComputerActionName };
  if (action === "click" || action === "scroll") {
    if (typeof input.elementId === "string" && input.elementId.trim()) {
      call.elementId = input.elementId.trim().slice(0, 128);
    } else {
      const x = intIn(input.x, bounds.width);
      const y = intIn(input.y, bounds.height);
      if (x === null || y === null) return { ok: false, error: "coordinates out of bounds" };
      call.x = x;
      call.y = y;
    }
  }
  if (action === "scroll") {
    const direction = input.direction;
    if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
      return { ok: false, error: "scroll direction must be up, down, left, or right" };
    }
    const amount = input.amount === undefined ? 1 : intIn(input.amount, 50);
    if (amount === null || amount < 1) return { ok: false, error: "scroll amount out of range" };
    call.direction = direction;
    call.amount = amount;
  }
  if (action === "type" || action === "write_file") {
    if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > MAX_TEXT) {
      return { ok: false, error: "text missing or over the length cap" };
    }
    call.text = input.text;
  }
  if (action === "press_key") {
    if (typeof input.key !== "string" || input.key.length > 64 || !KEY_RE.test(input.key)) {
      return { ok: false, error: "invalid key" };
    }
    call.key = input.key;
  }
  if (action === "open_app") {
    if (typeof input.app !== "string" || !OPEN_APPS.includes(input.app as (typeof OPEN_APPS)[number])) {
      return { ok: false, error: "app is not allowlisted" };
    }
    call.app = input.app;
  }
  if (action === "read_file" || action === "write_file") {
    if (typeof input.path !== "string" || input.path.length === 0 || input.path.length > MAX_PATH || input.path.includes("\0") || input.path.startsWith("/")) {
      return { ok: false, error: "path must be a relative workspace path" };
    }
    call.path = input.path;
  }
  if (action === "run_terminal") {
    if (typeof input.command !== "string" || input.command.length === 0 || input.command.length > MAX_CMD) {
      return { ok: false, error: "command missing or over the length cap" };
    }
    call.command = input.command;
  }
  return { ok: true, call };
}

export async function executeComputer(host: ComputerHost, raw: unknown, vision: boolean): Promise<ComputerResult> {
  const parsed = validateComputerCall(raw, host.bounds, vision);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.call.action === "screenshot") {
    const shot = await host.screenshot();
    if (!Number.isFinite(shot.bytes) || shot.bytes < 0) return { ok: false, error: "screenshot failed" };
    return { ok: true, observation: "screenshot", output: `screenshot:${shot.bytes}` };
  }
  if (parsed.call.action === "describe_screen") {
    const nodes = await host.describeScreen();
    return { ok: true, observation: "describe_screen", nodes, output: `${nodes.length} elements` };
  }
  const output = await host.act(parsed.call);
  return { ok: true, output };
}
