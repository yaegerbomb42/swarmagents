/**
 * effect.ts — parse the computer-mcp action-effect line appended to every
 * input-action tool result (core-23), so the live desktop can tell the user
 * whether the agent's click/type actually changed anything.
 *
 * The exact source formats (vm-image-desktop/computer-mcp/effect.mjs):
 *
 *   effect: NO visible change [near (x, y)] after 1.5s; focused window unchanged
 *   effect: screen changed [near (x, y)]; focus moved to "Save As"
 *   effect: screen changed [near (x, y)]; window title now "Save As"
 *
 * Anything else is not an effect line and returns null. Pure and DOM-free so
 * it unit-tests with node:test.
 */

export interface ActionEffect {
  /** Whether the screen visibly changed after the action settled. */
  changed: boolean;
  /** The newly focused window title, when focus moved. */
  focus?: string;
  /** Seconds the screen was watched before declaring no change. */
  elapsedS?: number;
}

const EFFECT_LINE_RE = /^effect: /;
const NO_CHANGE_RE =
  /^effect: NO visible change(?: near \([-\d]+, [-\d]+\))? after ([\d.]+)s; focused window unchanged$/;
const SCREEN_CHANGED_RE = /^effect: screen changed(?: near \([-\d]+, [-\d]+\))?$/;
const FOCUS_MOVED_RE =
  /^effect: screen changed(?: near \([-\d]+, [-\d]+\))?; focus moved to "([^"]*)"$/;
const TITLE_NOW_RE = /^effect: screen changed(?: near \([-\d]+, [-\d]+\))?; window title now "([^"]*)"$/;

/** Parse one line against the exact effect formats; null when none match. */
function parseEffectLineLine(line: string): ActionEffect | null {
  const trimmed = line.trim();
  if (!EFFECT_LINE_RE.test(trimmed)) return null;
  const none = NO_CHANGE_RE.exec(trimmed);
  if (none) return { changed: false, elapsedS: Number.parseFloat(none[1]) };
  if (SCREEN_CHANGED_RE.test(trimmed)) return { changed: true };
  const focus = FOCUS_MOVED_RE.exec(trimmed);
  if (focus) return { changed: true, focus: focus[1] || undefined };
  if (TITLE_NOW_RE.test(trimmed)) return { changed: true };
  return null;
}

/**
 * Extract the action effect from a tool result's output. The effect is a
 * line appended to the result text; the last matching line wins, so the
 * result can carry unrelated text before it.
 */
export function parseEffectLine(output: string): ActionEffect | null {
  if (typeof output !== "string") return null;
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const effect = parseEffectLineLine(lines[i] ?? "");
    if (effect) return effect;
  }
  return null;
}
