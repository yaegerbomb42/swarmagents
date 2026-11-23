/**
 * Fail-open observer for client->server RFB input messages.
 *
 * The HandbackSummarizer needs to know that the human sent input while
 * driving (it only counts events — see recordInput), but the live stream
 * must never be disturbed to learn that. This observer frames the same
 * client->server RFB messages rfb-filter.ts frames (with one deliberate
 * divergence: KeyEvent is framed at its true 8-byte wire size — see the
 * size table), decodes the input ones (KeyEvent, PointerEvent,
 * ClientCutText, QEMU extended key) into the takeover module's InputEvent
 * shape, and reports them through a callback.
 *
 * FAIL-OPEN BY DESIGN: any framing surprise (unknown type, over-limit
 * header, runaway buffer) permanently disables the observer for the
 * session and observe() returns [] forever after. The forwarded stream
 * is never touched — the bridge forwards the original bytes regardless
 * of what the observer does. This is the opposite of RfbInputFilter,
 * which is fail-closed because it is the view-only enforcement point.
 *
 * PRIVACY: ClientCutText payloads are never decoded into the event —
 * clipboard_set events carry an empty string. Typed text is never
 * reconstructed (key events carry keysym names only, one key at a time,
 * and consumers only count them). Nothing here logs payload bytes.
 */

import type { InputEvent } from "./takeover/types";

/** Mirrors rfb-filter.ts caps: beyond these, framing cannot be trusted. */
const MAX_ENCODINGS = 256;
const MAX_SCREENS = 16;
const MAX_CUT_TEXT_BYTES = 1_048_576;
/** Buffered-but-unframed bytes beyond this mean the stream is not RFB. */
const MAX_OBSERVE_BUFFER_BYTES = 2 * 1024 * 1024;

const MESSAGE_FIXED_SIZE: Record<number, number> = {
  0: 20, // SetPixelFormat
  2: -1, // SetEncodings
  3: 10, // FramebufferUpdateRequest
  // KeyEvent is 8 bytes on the wire (type, down-flag, 2 pad, keysym u32).
  // NOTE: rfb-filter.ts frames it as 6 — a pre-existing deviation that only
  // matters for a view-mode client that sends keys anyway (noVNC viewOnly
  // sends none; control mode passes through unframed). The observer follows
  // the wire spec so real driving input decodes correctly.
  4: 8, // KeyEvent
  5: 6, // PointerEvent
  6: -1, // ClientCutText
  150: 10, // EnableContinuousUpdates
  248: -1, // ClientFence
  250: 4, // xvp
  251: -1, // SetDesktopSize
  255: -1, // QEMU extended key event
};

// Pointer button-mask bits (RFB PointerEvent).
const BUTTON_LEFT = 1;
const BUTTON_MIDDLE = 2;
const BUTTON_RIGHT = 4;
const BUTTON_WHEEL_UP = 8;
const BUTTON_WHEEL_DOWN = 16;
const BUTTON_WHEEL_LEFT = 32;
const BUTTON_WHEEL_RIGHT = 64;

// Modifier keysyms (X11). Tracked so key events can report modifier state.
const MODIFIER_KEYSYMS = new Map<number, "ctrl" | "alt" | "shift" | "meta">([
  [0xffe1, "shift"], // Shift_L
  [0xffe2, "shift"], // Shift_R
  [0xffe3, "ctrl"], // Control_L
  [0xffe4, "ctrl"], // Control_R
  [0xffe7, "meta"], // Meta_L
  [0xffe8, "meta"], // Meta_R
  [0xffe9, "alt"], // Alt_L
  [0xffea, "alt"], // Alt_R
  [0xffeb, "meta"], // Super_L
  [0xffec, "meta"], // Super_R
]);

const SPECIAL_KEY_NAMES = new Map<number, string>([
  [0xff08, "Backspace"],
  [0xff09, "Tab"],
  [0xff0d, "Return"],
  [0xff1b, "Escape"],
  [0xffff, "Delete"],
  [0xff50, "Home"],
  [0xff51, "Left"],
  [0xff52, "Up"],
  [0xff53, "Right"],
  [0xff54, "Down"],
  [0xff55, "Page_Up"],
  [0xff56, "Page_Down"],
  [0xff57, "End"],
  [0xff63, "Insert"],
  [0xffe1, "Shift_L"],
  [0xffe2, "Shift_R"],
  [0xffe3, "Control_L"],
  [0xffe4, "Control_R"],
  [0xffe7, "Meta_L"],
  [0xffe8, "Meta_R"],
  [0xffe9, "Alt_L"],
  [0xffea, "Alt_R"],
  [0xffeb, "Super_L"],
  [0xffec, "Super_R"],
  [0xffe5, "Caps_Lock"],
  [0xff7f, "Num_Lock"],
]);

function keysymName(keysym: number): string {
  const special = SPECIAL_KEY_NAMES.get(keysym);
  if (special) return special;
  // Function keys F1..F12 are 0xffbe..0xffc9.
  if (keysym >= 0xffbe && keysym <= 0xffc9) return `F${keysym - 0xffbe + 1}`;
  // Printable ASCII keysyms are the code point itself.
  if (keysym >= 0x20 && keysym <= 0x7e) return String.fromCharCode(keysym);
  return `keysym:${keysym}`;
}

function keysymCode(keysym: number, key: string): string {
  if (keysym >= 0x61 && keysym <= 0x7a) return `Key${key.toUpperCase()}`; // a-z
  if (keysym >= 0x41 && keysym <= 0x5a) return `Key${key}`; // A-Z
  if (keysym >= 0x30 && keysym <= 0x39) return `Digit${key}`; // 0-9
  if (key === " ") return "Space";
  return key;
}

export class RfbInputObserver {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private broken = false;
  private prevButtonMask = 0;
  private readonly pressedModifiers = new Set<number>();

  /** True once framing failed; the observer never reports again. */
  get disabled(): boolean {
    return this.broken;
  }

  /**
   * Feed one decoded client->server payload. Returns the input events
   * framed from it (possibly none). Never throws.
   */
  observe(chunk: Buffer): InputEvent[] {
    if (this.broken || chunk.length === 0) return [];
    try {
      return this.frame(chunk);
    } catch {
      // Fail open: stop observing, never disturb the stream.
      this.broken = true;
      this.buffer = Buffer.alloc(0);
      return [];
    }
  }

  private frame(chunk: Buffer): InputEvent[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_OBSERVE_BUFFER_BYTES) {
      throw new Error("observe buffer overflow");
    }
    const events: InputEvent[] = [];
    while (this.buffer.length > 0) {
      const type = this.buffer.readUInt8(0);
      let size = MESSAGE_FIXED_SIZE[type] ?? -2;
      if (size === -2) throw new Error(`unknown RFB client message type ${type}`);
      if (size === -1) {
        if (type === 2) {
          if (this.buffer.length < 4) break;
          const count = this.buffer.readUInt16BE(2);
          if (count > MAX_ENCODINGS) throw new Error("SetEncodings count exceeds limit");
          size = 4 + count * 4;
        } else if (type === 6) {
          if (this.buffer.length < 8) break;
          const length = this.buffer.readUInt32BE(4);
          if (length > MAX_CUT_TEXT_BYTES) throw new Error("ClientCutText length exceeds limit");
          size = 8 + length;
        } else if (type === 248) {
          if (this.buffer.length < 9) break;
          size = 9 + this.buffer.readUInt8(8);
        } else if (type === 251) {
          if (this.buffer.length < 8) break;
          const screens = this.buffer.readUInt8(6);
          if (screens > MAX_SCREENS) throw new Error("SetDesktopSize screens exceed limit");
          size = 8 + screens * 16;
        } else {
          // QEMU (255): only subtype 0 (extended key event, 12 bytes) is framed.
          if (this.buffer.length < 2) break;
          if (this.buffer.readUInt8(1) !== 0) throw new Error("unsupported QEMU subtype");
          size = 12;
        }
      }
      if (this.buffer.length < size) break; // partial message: wait for more bytes
      const message = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      const event = this.decode(type, message);
      if (event) events.push(event);
    }
    return events;
  }

  private decode(type: number, message: Buffer): InputEvent | null {
    switch (type) {
      case 4: // KeyEvent: down-flag u8 @1, padding @2..3, keysym u32BE @4
        return this.keyEvent(message.readUInt8(1) !== 0, message.readUInt32BE(4));
      case 255: // QEMU extended key: subtype @1, down-flag u16BE @2, keysym u32BE @4
        return this.keyEvent(message.readUInt16BE(2) !== 0, message.readUInt32BE(4));
      case 5: // PointerEvent: button-mask u8 @1, x u16BE @2, y u16BE @4
        return this.pointerEvent(message.readUInt8(1), message.readUInt16BE(2), message.readUInt16BE(4));
      case 6: // ClientCutText: counted, payload never read into the event.
        return { kind: "clipboard_set", text: "" };
      default:
        return null; // framing-only messages (encodings, format, requests)
    }
  }

  private keyEvent(down: boolean, keysym: number): InputEvent {
    if (MODIFIER_KEYSYMS.has(keysym)) {
      if (down) this.pressedModifiers.add(keysym);
      else this.pressedModifiers.delete(keysym);
    }
    const modifiers = { ctrl: false, alt: false, shift: false, meta: false };
    for (const pressed of this.pressedModifiers) {
      const name = MODIFIER_KEYSYMS.get(pressed);
      if (name) modifiers[name] = true;
    }
    const key = keysymName(keysym);
    return {
      kind: down ? "key_down" : "key_up",
      key,
      code: keysymCode(keysym, key),
      modifiers,
    };
  }

  private pointerEvent(mask: number, x: number, y: number): InputEvent {
    const prev = this.prevButtonMask;
    this.prevButtonMask = mask;

    // Wheel ticks are momentary bits in the mask; report them first.
    if (mask & (BUTTON_WHEEL_UP | BUTTON_WHEEL_DOWN | BUTTON_WHEEL_LEFT | BUTTON_WHEEL_RIGHT)) {
      return {
        kind: "mouse_wheel",
        x,
        y,
        deltaX: mask & BUTTON_WHEEL_LEFT ? -1 : mask & BUTTON_WHEEL_RIGHT ? 1 : 0,
        deltaY: mask & BUTTON_WHEEL_UP ? -1 : mask & BUTTON_WHEEL_DOWN ? 1 : 0,
      };
    }
    const buttons: Array<[number, "left" | "middle" | "right"]> = [
      [BUTTON_LEFT, "left"],
      [BUTTON_MIDDLE, "middle"],
      [BUTTON_RIGHT, "right"],
    ];
    for (const [bit, name] of buttons) {
      const was = (prev & bit) !== 0;
      const is = (mask & bit) !== 0;
      if (is && !was) return { kind: "mouse_down", x, y, button: name };
      if (!is && was) return { kind: "mouse_up", x, y, button: name };
    }
    return { kind: "mouse_move", x, y };
  }
}
