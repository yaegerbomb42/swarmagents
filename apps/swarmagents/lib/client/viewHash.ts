/**
 * The current page/tab, mirrored in the URL hash so a reload lands back on
 * the page the user was on (r3: reload dropped the user on Overview).
 *
 * Hash format: `#view=overview` for the landing page, or
 * `#view=computer&tab=terminal|browser|files|desktop` for the workspace.
 * Unknown or missing values fall back to the Overview landing page.
 */

export type WorkspaceView = "terminal" | "browser" | "files" | "desktop";

export interface ViewHashState {
  /** True while the Overview landing page is shown. */
  landing: boolean;
  /** Which tab of the computer screen is active (workspace only). */
  view: WorkspaceView;
}

const VIEWS: ReadonlySet<string> = new Set(["terminal", "browser", "files", "desktop"]);

export function parseViewHash(hash: string): ViewHashState {
  const fallback: ViewHashState = { landing: true, view: "terminal" };
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return fallback;
  const params = new URLSearchParams(raw);
  const viewParam = params.get("view");
  if (viewParam !== "computer" && viewParam !== "overview") return fallback;
  const tabParam = params.get("tab");
  return {
    landing: viewParam === "overview",
    view: tabParam !== null && VIEWS.has(tabParam) ? (tabParam as WorkspaceView) : "terminal",
  };
}

export function buildViewHash(state: ViewHashState): string {
  if (state.landing) return "#view=overview";
  return `#view=computer&tab=${state.view}`;
}
