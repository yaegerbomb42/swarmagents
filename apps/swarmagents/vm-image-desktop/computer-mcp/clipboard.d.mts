export const MAX_CLIPBOARD_READ_CHARS: number;
export function capClipboardText(
  text: unknown,
  max?: number,
): { text: string; truncated: boolean; total: number };
export function writeClipboard(options: {
  spawnImpl: (command: string, args: string[], options: Record<string, unknown>) => unknown;
  text: string;
  selection?: "clipboard" | "primary";
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }>;

export function readClipboard(options: {
  spawnImpl: (command: string, args: string[], options: Record<string, unknown>) => unknown;
  selection?: "clipboard" | "primary";
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error?: string }>;
