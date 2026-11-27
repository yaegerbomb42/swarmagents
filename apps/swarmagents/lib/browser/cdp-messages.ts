/**
 * User-facing strings for the CDP browser mirror (lib/browser/cdp-endpoint).
 *
 * This module has NO imports on purpose: the Browser tab component
 * (minimalist-ui/src/components/BrowserView.tsx) needs the unavailable-mode
 * message, and it is bundled for the browser by webpack — importing the
 * endpoint module itself would drag playwright-core (Node-only) into the
 * client bundle and fail the build on Node builtins (module/fs/dns/...).
 * Server code imports these from ./cdp-endpoint, which re-exports them.
 */

/**
 * Shown when the browser lives inside the user's computer and there is no
 * headless browser to mirror (fake driver, SWARM_BROWSER_HOST unset): the
 * Browser tab says so instead of showing a frame.
 */
export const BROWSER_IN_VM_MESSAGE = "Browser runs inside your computer — open the Screen tab";

/** Reason when the VM browser is reachable but has no open tab to mirror. */
export const CDP_NO_TAB_MESSAGE =
  "The VM browser has no open tab yet — open the browser in the VM or wait for the agent to navigate.";
