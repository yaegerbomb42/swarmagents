export interface RunModeLike {
  mode?: string;
  label?: string;
  reason?: string;
  capabilities?: { vision?: boolean; tools?: boolean; computerUse?: boolean };
}

export type RunModeInput = string | RunModeLike | null | undefined;

/**
 * Compact badge label for a run mode returned by the provider key probe.
 * Returns null when there is no runMode (older servers / missing data) so
 * callers can render nothing instead of crashing.
 */
export function runModeLabel(input: RunModeInput): string | null {
  let mode: string | undefined;
  let label: string | undefined;
  let vision: boolean | undefined;

  if (typeof input === "string") {
    mode = input;
  } else if (input && typeof input === "object") {
    mode = input.mode;
    label = input.label;
    vision = input.capabilities?.vision;
  } else {
    return null;
  }

  if (!mode && !label) return null;

  switch (mode) {
    case "gui":
      return "Vision desktop";
    case "text-desktop":
      return "Text desktop (no vision)";
    case "chat":
      return label ?? "Plain chat";
    case "text":
      return label ?? "Text mode";
    default:
      if (label) return label;
      if (mode) return mode;
      return null;
  }
}

export const runModeBadge = runModeLabel;
export const labelForRunMode = runModeLabel;
export const badgeForRunMode = runModeLabel;
export const runModeToLabel = runModeLabel;

export default runModeLabel;
