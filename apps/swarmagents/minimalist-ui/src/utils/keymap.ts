/**
 * Keyboard shortcut mapping for the swarmagents workspace.
 *
 * Kept as a pure module so the key→action logic is unit-testable without a
 * DOM. The app attaches a window keydown listener and feeds it through
 * `mapKeyToAction`; this module never touches the DOM.
 *
 * Modifier chords (Cmd/Ctrl+K, Cmd/Ctrl+1..4) work anywhere — they cannot be
 * typed as literal text — while bare keys (? and Escape) are ignored when the
 * focus is inside an input so they never hijack normal typing. Escape is the
 * one deliberate exception: while typing it maps to stopRun (stop the active
 * run), otherwise to close (dismiss overlays).
 */

export type UiView = "terminal" | "browser" | "files";

/** Digit order for Cmd/Ctrl+1..4 view switching. */
export const VIEW_ORDER: readonly UiView[] = ["terminal", "browser", "files"];

export type ShortcutAction =
  | { type: "focusInput" }
  | { type: "view"; view: UiView }
  /** Opens the Telemetry timeline drawer (⌘4). */
  | { type: "telemetry" }
  | { type: "help" }
  | { type: "close" }
  /** Escape pressed while typing: stop the active/queued run. */
  | { type: "stopRun" };

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
}

const VIEW_DIGITS = ["1", "2", "3"] as const;

export function mapKeyToAction(event: KeyEventLike, isTyping: boolean): ShortcutAction | null {
  // Modifier chords are safe to honor even while typing.
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    if (event.key.toLowerCase() === "k") return { type: "focusInput" };
    const index = VIEW_DIGITS.indexOf(event.key as (typeof VIEW_DIGITS)[number]);
    if (index >= 0) return { type: "view", view: VIEW_ORDER[index] };
    if (event.key === "4") return { type: "telemetry" };
    return null;
  }

  // Escape while typing stops the active run (a "cancel" affordance that
  // works without leaving the composer); bare keys are otherwise ignored so
  // text entry is never hijacked.
  if (isTyping) {
    if (event.key === "Escape") return { type: "stopRun" };
    return null;
  }

  if (event.key === "?") return { type: "help" };
  if (event.key === "Escape") return { type: "close" };
  return null;
}
