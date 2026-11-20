/**
 * Focus trapping for modal dialogs (Agent Card, keyboard shortcuts overlay).
 *
 * Kept as a small pure core plus a React hook so the Tab-cycling logic is
 * unit-testable without a DOM. The hook focuses the first focusable element
 * on open, wraps Tab/Shift+Tab inside the dialog, and restores focus to the
 * element that had it when the dialog closes.
 */
import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elements inside `container` that can receive keyboard focus, in DOM order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el): el is HTMLElement =>
      // Duck-typed (not instanceof) so the list is testable without a DOM.
      typeof (el as HTMLElement).focus === "function" &&
      !(el as HTMLElement).hasAttribute("disabled") &&
      (el as HTMLElement).tabIndex >= 0,
  );
}

/**
 * Pure Tab-cycle step: given the focusable list and the index that currently
 * has focus (-1 when focus is outside the list), return the index Tab
 * (or Shift+Tab) should move to, wrapping at both ends.
 */
export function cycleTabIndex(count: number, current: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (shiftKey) return current <= 0 ? count - 1 : current - 1;
  return current < 0 || current >= count - 1 ? 0 : current + 1;
}

/** True for an element the user types text into (a field, a text area, editable content). */
export function isTextEntry(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(el.type ?? "text");
}

export interface FocusTrapOptions {
  /**
   * For a dialog that opens by itself (an approval arriving mid-run): when the
   * user is typing in a field, leave the cursor there instead of taking it.
   * Taking it would turn the keys they are already pressing into input to the
   * dialog. Tab still moves into the dialog.
   */
  deferToTyping?: boolean;
}

/**
 * Trap keyboard focus inside the referenced element while `active`.
 * Returns the ref to attach to the dialog element.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, options: FocusTrapOptions = {}) {
  const ref = useRef<T | null>(null);
  const deferToTyping = options.deferToTyping === true;

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = getFocusableElements(container);
    // Focus the first focusable element (usually the close button); if the
    // dialog has none, make the container itself focusable and focus it.
    if (deferToTyping && isTextEntry(previouslyFocused)) {
      // Focus stays where the user is typing; Tab brings it in (below).
    } else if (focusables.length > 0) focusables[0].focus();
    else {
      container.tabIndex = -1;
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const els = getFocusableElements(container);
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const current = els.indexOf(document.activeElement as HTMLElement);
      const next = cycleTabIndex(els.length, current, e.shiftKey);
      if (next < 0) return;
      // Only intervene when Tab would leave the dialog (wrap point) or when
      // focus somehow escaped it; otherwise let the browser move focus.
      const leaving =
        (current === -1) ||
        (!e.shiftKey && current === els.length - 1) ||
        (e.shiftKey && current === 0);
      if (!leaving) return;
      e.preventDefault();
      els[next].focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, deferToTyping]);

  return ref;
}
