"use client";

/**
 * ShortcutsHelp — the discoverability panel for the console's keyboard
 * shortcuts.
 *
 * The open '?' button in the header opens this small sheet. It lists exactly
 * the shortcuts the console actually supports, verified against the code:
 * the global chords in App.tsx (⌘/Ctrl+K opens the command palette,
 * ⌘/Ctrl+Shift+O starts a new chat, Esc for dialogs), the composer's
 * the computer terminal's Ctrl+C cancel. If a shortcut is ever removed or
 * remapped, update SHORTCUT_GROUPS here to keep the panel truthful.
 */

import React from "react";
import { Sheet } from "./ui";

export interface ShortcutEntry {
  /** Keys that trigger the shortcut, in display order; "⌘/Ctrl" covers both platforms. */
  keys: string[];
  /** What the shortcut does. */
  description: string;
}

export interface ShortcutGroup {
  title: string;
  /** When the shortcut only applies in a spot, say where. */
  context?: string;
  entries: ShortcutEntry[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Chat",
    entries: [
      { keys: ["⌘/Ctrl", "K"], description: "Open the command palette" },
      { keys: ["⌘/Ctrl", "Shift", "O"], description: "Start a new chat" },
      { keys: ["Enter"], description: "Send the message (in the composer)" },
      { keys: ["Shift", "Enter"], description: "Add a new line (in the composer)" },
    ],
  },
  {
    title: "Panels",
    entries: [{ keys: ["Esc"], description: "Close the open dialog or panel" }],
  },
  {
    title: "Approval prompt",
    context: "When an approval prompt is showing",
    entries: [
      { keys: ["A"], description: "Approve the pending action" },
      { keys: ["D"], description: "Deny the pending action" },
      { keys: ["Shift", "A"], description: "Always allow for this run" },
    ],
  },
  {
    title: "Computer terminal",
    context: "In the computer view",
    entries: [{ keys: ["Ctrl", "C"], description: "Cancel the running command" }],
  },
];

export interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts" side="right" widthClass="sm:max-w-[380px]" testId="shortcuts-help">
      <div className="flex flex-col gap-5 px-4 py-3" data-testid="shortcuts-help-list">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-sa-fg3">{group.title}</h3>
            {group.context && <p className="mt-0.5 text-[12px] text-sa-fg3">{group.context}</p>}
            <ul className="mt-1.5 flex flex-col gap-2">
              {group.entries.map((entry, index) => (
                <li
                  key={`${group.title}-${index}`}
                  data-testid="shortcut-row"
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-[13px] leading-snug text-sa-fg2">{entry.description}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {entry.keys.map((key, keyIndex) => (
                      <React.Fragment key={key}>
                        {keyIndex > 0 && <span className="text-[12px] text-sa-fg3">+</span>}
                        <kbd className="grid min-w-6 place-items-center rounded-md border border-sa-line bg-sa-raised px-1.5 py-0.5 text-[11px] font-medium text-sa-fg">
                          {key}
                        </kbd>
                      </React.Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  );
}

export default ShortcutsHelp;
