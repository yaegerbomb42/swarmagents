import type { BrowserSession } from "./runtime";

// ═══════ Viewer input injection ═══════
//
// The live viewer streams CDP screencast frames. When the user takes over, their mouse and
// keyboard events arrive over an authenticated POST and are replayed into the page through the
// same CDP session that produces the frames, so what the user does is exactly what the page sees.

/** A mouse event from the viewer. x/y are in page CSS pixels (the viewer scales its own coords). */
export interface MouseInput {
  kind: "mouse";
  action: "move" | "down" | "up" | "wheel";
  x: number;
  y: number;
  /** 0 none, 1 left, 2 middle, 3 right. */
  button?: number;
  deltaY?: number;
  /** Modifier bits (1 alt, 2 ctrl, 4 meta, 8 shift) as sent by the browser event. */
  modifiers?: number;
}

/** A key event from the viewer. */
export interface KeyInput {
  kind: "key";
  action: "down" | "up" | "char";
  key: string;
  text?: string;
  code?: string;
  modifiers?: number;
}

export type ViewerInput = MouseInput | KeyInput;

/** Minimal virtual-key codes for keys that aren't plain text (Enter, Tab, arrows, …). */
const VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
};

const keyCodeOf = (key: string) => VK[key] ?? (/^[a-zA-Z]$/.test(key) ? key.toUpperCase().charCodeAt(0) : undefined);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Replay one viewer input into the page. Returns false when the session is gone or its CDP
 * session has not started yet (the viewer will simply try again on the next event).
 */
export async function dispatchInput(session: BrowserSession, input: ViewerInput): Promise<boolean> {
  if (session.isClosed) return false;
  session.touch();
  let cdp = session.cdpSession();
  if (!cdp) {
    // The screencast (and therefore the CDP session) may not be attached yet — start it.
    await session.startScreencast().catch(() => {});
    cdp = session.cdpSession();
  }
  if (!cdp) return false;

  const { width, height } = session.limits.viewport;
  if (input.kind === "mouse") {
    const x = clamp(Math.round(input.x), 0, width);
    const y = clamp(Math.round(input.y), 0, height);
    session.pointer = { x, y };
    if (input.action === "wheel") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: input.deltaY ?? 120,
        modifiers: input.modifiers ?? 0,
      });
      return true;
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: input.action === "move" ? "mouseMoved" : input.action === "down" ? "mousePressed" : "mouseReleased",
      x,
      y,
      button: input.button === 2 ? "middle" : input.button === 3 ? "right" : "left",
      buttons: input.action === "down" ? 1 : 0,
      clickCount: input.action === "move" ? 0 : 1,
      modifiers: input.modifiers ?? 0,
    });
    return true;
  }

  // Keyboard.
  const vk = keyCodeOf(input.key);
  if (input.action === "char") {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "char",
      text: input.text ?? input.key,
      unmodifiedText: input.text ?? input.key,
      modifiers: input.modifiers ?? 0,
    });
    return true;
  }
  await cdp.send("Input.dispatchKeyEvent", {
    type: input.action === "down" ? "keyDown" : "keyUp",
    key: input.key,
    code: input.code ?? "",
    text: input.action === "down" && input.key.length === 1 ? input.key : undefined,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: input.modifiers ?? 0,
  });
  return true;
}

/** Validate and narrow an untrusted body from the viewer control endpoint. */
export function parseInput(raw: unknown): ViewerInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "mouse") {
    const action = String(o.action);
    if (!["move", "down", "up", "wheel"].includes(action)) return null;
    if (typeof o.x !== "number" || typeof o.y !== "number") return null;
    return {
      kind: "mouse",
      action: action as MouseInput["action"],
      x: o.x,
      y: o.y,
      button: typeof o.button === "number" ? o.button : undefined,
      deltaY: typeof o.deltaY === "number" ? o.deltaY : undefined,
      modifiers: typeof o.modifiers === "number" ? o.modifiers : undefined,
    };
  }
  if (o.kind === "key") {
    const action = String(o.action);
    if (!["down", "up", "char"].includes(action) || typeof o.key !== "string" || !o.key) return null;
    return {
      kind: "key",
      action: action as KeyInput["action"],
      key: o.key,
      text: typeof o.text === "string" ? o.text : undefined,
      code: typeof o.code === "string" ? o.code : undefined,
      modifiers: typeof o.modifiers === "number" ? o.modifiers : undefined,
    };
  }
  return null;
}
