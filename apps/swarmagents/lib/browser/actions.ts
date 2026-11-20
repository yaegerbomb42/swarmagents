/**
 * Interactive browser actions for BrowserManager (lib/browser/manager.ts).
 *
 * These run inside the same SSRF / DNS-rebinding guardrails as navigation:
 * the manager re-verifies the page URL against checkNavigationAsync before
 * and after every action, so a click or script that redirects the page into
 * private space is caught and the page is blanked. Actions themselves are
 * bounded (selector/text/key length, 10s timeout) and `evaluate` only
 * returns JSON-serializable values.
 */

import type { Page } from "playwright-core";

export type BrowserAction =
  | { kind: "click"; selector: string; button?: "left" | "right" | "middle"; clickCount?: number }
  | { kind: "type"; selector: string; text: string; clear?: boolean; submit?: boolean }
  | { kind: "press"; key: string; selector?: string }
  | { kind: "scroll"; deltaX?: number; deltaY?: number; selector?: string }
  | { kind: "wait"; selector: string; state?: "visible" | "attached" | "hidden" };

export interface BrowserDiagnosticEntry {
  ts: number;
  kind: "console" | "pageerror" | "requestfailed";
  level: string;
  message: string;
  url?: string;
}

const ACTION_TIMEOUT_MS = 10_000;
const MAX_TEXT_LEN = 16_384;
const MAX_SELECTOR_LEN = 512;

function validateSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length > MAX_SELECTOR_LEN) {
    throw new Error("Invalid selector length");
  }
  return trimmed;
}

export async function executeBrowserAction(page: Page, action: BrowserAction): Promise<void> {
  switch (action.kind) {
    case "click": {
      const selector = validateSelector(action.selector);
      await page.locator(selector).first().click({
        button: action.button ?? "left",
        clickCount: Math.min(Math.max(action.clickCount ?? 1, 1), 3),
        timeout: ACTION_TIMEOUT_MS,
      });
      return;
    }
    case "type": {
      const selector = validateSelector(action.selector);
      if (typeof action.text !== "string" || action.text.length > MAX_TEXT_LEN) {
        throw new Error(`Text must be <= ${MAX_TEXT_LEN} characters`);
      }
      const locator = page.locator(selector).first();
      if (action.clear) {
        await locator.fill(action.text, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await locator.type(action.text, { timeout: ACTION_TIMEOUT_MS });
      }
      if (action.submit) {
        await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS });
      }
      return;
    }
    case "press": {
      const key = action.key.trim();
      if (!key || key.length > 64) throw new Error("Invalid key");
      if (action.selector) {
        await page.locator(validateSelector(action.selector)).first().press(key, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.press(key);
      }
      return;
    }
    case "scroll": {
      const dx = Number.isFinite(action.deltaX) ? Math.trunc(action.deltaX!) : 0;
      const dy = Number.isFinite(action.deltaY) ? Math.trunc(action.deltaY!) : 600;
      if (action.selector) {
        await page.locator(validateSelector(action.selector)).first().hover({ timeout: ACTION_TIMEOUT_MS });
      }
      await page.mouse.wheel(dx, dy);
      return;
    }
    case "wait": {
      const selector = validateSelector(action.selector);
      await page.locator(selector).first().waitFor({
        state: action.state ?? "visible",
        timeout: ACTION_TIMEOUT_MS,
      });
      return;
    }
  }
}

/**
 * Evaluate a bounded JS expression in page context and return JSON-serializable output.
 * Refuses non-serializable handles and enforces a hard race timeout.
 */
export async function evaluatePageExpression(
  page: Page,
  expression: string,
  timeoutMs = 5_000,
): Promise<unknown> {
  const trimmed = expression.trim();
  if (!trimmed || trimmed.length > 8_192) {
    throw new Error("Expression must be 1..8192 characters");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate((expr) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${expr});`);
        const raw = fn();
        return raw === undefined ? null : JSON.parse(JSON.stringify(raw));
      }, trimmed),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Page evaluation timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
