"use client";

/**
 * CommandPalette — the Cmd/Ctrl+K command palette.
 *
 * One keystroke to every action in the workspace: new thread, jump to a run,
 * settings, library, VM screen, provider switch, schedules, shortcuts — plus
 * the recent runs themselves. Typing filters by subsequence match (the query
 * need not be a substring: "ns" finds "New thread"); ArrowUp/ArrowDown move
 * the selection with wraparound, Enter runs it, Esc closes.
 *
 * The palette reuses the app's existing shortcut system: it opens on the
 * Cmd/Ctrl+K chord registered in App.tsx's `workspaceChordAction` and listed
 * in ShortcutsHelp.tsx — it does not register its own global keys. The
 * key-handling core (query matching, selection movement, key mapping) is pure
 * so it is pinned by tests without a DOM; the component itself is a thin
 * shell over those helpers plus the shared `useFocusTrap`.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "../utils/cn";
import { useFocusTrap } from "../utils/focusTrap";

export interface PaletteItem {
  /** Stable id, e.g. "new-thread" or "run:<threadId>". */
  id: string;
  /** Group heading the item belongs to ("Actions", "Recent runs"). */
  group: string;
  /** What the row shows. */
  label: string;
  /** Secondary text, e.g. where the command leads. */
  hint?: string;
  /** Shortcut keys shown as kbd chips, e.g. ["⌘/Ctrl", "Shift", "O"]. */
  shortcut?: string[];
  /** The icon for the row. */
  icon?: React.ReactNode;
  /** A disabled row is shown but cannot be run. */
  disabled?: boolean;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** All items; the palette filters and groups them. */
  items: readonly PaletteItem[];
  /** Starting query (tests); the live palette always starts empty. */
  defaultQuery?: string;
}

/**
 * Subsequence (fuzzy) match: every character of `query` must appear in
 * `label` in order, case-insensitively. An empty query matches everything.
 */
export function matchPaletteQuery(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = label.toLowerCase();
  let at = 0;
  for (const ch of needle) {
    at = haystack.indexOf(ch, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/** Items whose label or hint matches the query, in their original order. */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
): PaletteItem[] {
  if (query.trim().length === 0) return [...items];
  return items.filter(
    (item) => matchPaletteQuery(item.label, query) || (item.hint !== undefined && matchPaletteQuery(item.hint, query)),
  );
}

/** What a key press inside the palette means. Enter runs, Esc closes. */
export function paletteKeyAction(event: { key: string }): "up" | "down" | "run" | "close" | null {
  if (event.key === "ArrowDown") return "down";
  if (event.key === "ArrowUp") return "up";
  if (event.key === "Enter") return "run";
  if (event.key === "Escape") return "close";
  return null;
}

/**
 * Selection step with wraparound, skipping disabled items. Returns -1 when
 * there is nothing selectable.
 */
export function movePaletteSelection(
  items: readonly PaletteItem[],
  current: number,
  direction: "up" | "down",
): number {
  const selectable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.disabled)
    .map(({ index }) => index);
  if (selectable.length === 0) return -1;
  const step = direction === "down" ? 1 : -1;
  const at = selectable.indexOf(current);
  if (at === -1) return direction === "down" ? selectable[0] : selectable[selectable.length - 1];
  return selectable[(at + step + selectable.length) % selectable.length];
}

export function CommandPalette({ open, onClose, items, defaultQuery = "" }: CommandPaletteProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const [query, setQuery] = useState(defaultQuery);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query]);
  const clampedSelected =
    filtered.length === 0 ? -1 : Math.min(Math.max(selected, 0), filtered.length - 1);
  // The selection always lands on a runnable row, even when the filter
  // changes under it (e.g. the selected row stops matching).
  const effectiveSelected =
    clampedSelected === -1
      ? -1
      : filtered[clampedSelected]?.disabled
        ? movePaletteSelection(filtered, clampedSelected, "down")
        : clampedSelected;

  // A fresh open starts empty with the first runnable row selected.
  useEffect(() => {
    if (!open) return;
    setQuery(defaultQuery);
    setSelected(0);
    inputRef.current?.focus();
  }, [open, defaultQuery]);

  // Keep the selected row visible when the user arrows through a long list.
  useEffect(() => {
    if (effectiveSelected < 0) return;
    itemRefs.current[effectiveSelected]?.scrollIntoView({ block: "nearest" });
  }, [effectiveSelected]);

  if (!open) return null;

  const groups: Array<{ title: string; items: PaletteItem[] }> = [];
  for (const item of filtered) {
    const group = groups.find((g) => g.title === item.group);
    if (group) group.items.push(item);
    else groups.push({ title: item.group, items: [item] });
  }

  const runItem = (item: PaletteItem) => {
    if (item.disabled) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const action = paletteKeyAction(event);
    if (action === null) return;
    if (action === "close") {
      event.preventDefault();
      onClose();
      return;
    }
    if (action === "run") {
      event.preventDefault();
      if (effectiveSelected >= 0) runItem(filtered[effectiveSelected]);
      return;
    }
    event.preventDefault();
    setSelected(movePaletteSelection(filtered, effectiveSelected, action));
  };

  // Flat index across groups, so selection and refs stay aligned.
  let flatIndex = -1;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center px-3 pt-[12vh]" data-testid="command-palette">
      <div
        className="sa-fade absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
        data-testid="command-palette-backdrop"
      />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        className="sa-enter relative w-full max-w-xl overflow-hidden rounded-2xl border border-white/[0.12] bg-zinc-950/90 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_64px_rgba(0,0,0,0.65)] backdrop-blur-2xl backdrop-saturate-150"
      >
        <div className="flex items-center gap-2 border-b border-sa-line px-3">
          <Search className="h-4 w-4 shrink-0 text-sa-fg3" aria-hidden />
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            placeholder="Type a command or search runs…"
            aria-label="Search commands"
            aria-expanded={filtered.length > 0}
            aria-controls="command-palette-list"
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-sa-fg outline-none placeholder:text-sa-fg3"
          />
          <kbd className="grid shrink-0 place-items-center rounded-md border border-sa-line bg-sa-raised px-1.5 py-0.5 text-[11px] font-medium text-sa-fg3">
            esc
          </kbd>
        </div>
        <ul
          id="command-palette-list"
          role="listbox"
          aria-label="Commands"
          data-testid="command-palette-list"
          className="sa-scroll max-h-[46vh] overflow-y-auto p-1.5"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-[13px] text-sa-fg3" data-testid="command-palette-empty">
              No matching commands
            </li>
          )}
          {groups.map((group) => (
            <React.Fragment key={group.title}>
              <li
                aria-hidden
                data-testid="command-palette-group"
                className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-sa-fg3"
              >
                {group.title}
              </li>
              {group.items.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                const isSelected = index === effectiveSelected;
                return (
                  <li
                    key={item.id}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={item.disabled || undefined}
                    data-testid="palette-item"
                    onMouseEnter={() => {
                      if (!item.disabled) setSelected(index);
                    }}
                    onClick={() => runItem(item)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2",
                      isSelected ? "bg-white/[0.09] text-sa-fg" : "text-sa-fg2",
                      item.disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-sa-fg2" aria-hidden>
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] leading-snug">{item.label}</span>
                      {item.hint && <span className="block truncate text-[12px] leading-snug text-sa-fg3">{item.hint}</span>}
                    </span>
                    {item.shortcut && (
                      <span className="flex shrink-0 items-center gap-1" aria-hidden>
                        {item.shortcut.map((key, keyIndex) => (
                          <React.Fragment key={key}>
                            {keyIndex > 0 && <span className="text-[11px] text-sa-fg3">+</span>}
                            <kbd className="grid min-w-6 place-items-center rounded-md border border-sa-line bg-sa-raised px-1.5 py-0.5 text-[11px] font-medium text-sa-fg">
                              {key}
                            </kbd>
                          </React.Fragment>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </React.Fragment>
          ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-sa-line px-3 py-2 text-[11px] text-sa-fg3">
          <span>
            <kbd className="rounded border border-sa-line bg-sa-raised px-1 py-0.5 font-medium">↑↓</kbd> to navigate
          </span>
          <span>
            <kbd className="rounded border border-sa-line bg-sa-raised px-1 py-0.5 font-medium">↵</kbd> to run
          </span>
          <span>
            <kbd className="rounded border border-sa-line bg-sa-raised px-1 py-0.5 font-medium">esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
