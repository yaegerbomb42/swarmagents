/**
 * Output lenses — one specialised reading of an agent message.
 *
 * A lens is a short, focused prompt that re-reads what the agent said through
 * a different lens (plain language, executive summary, code review, security
 * audit, architecture diagram). The user picks a lens on any agent message;
 * the answer is rendered inline under that message.
 *
 * This module is dependency-free (no node imports) so the browser UI and the
 * server routes share the same lens catalogue.
 */

/** The lenses offered on every agent message. */
export const LENS_IDS = ["eli5", "executive", "code-review", "security", "architecture"] as const;

export type LensId = (typeof LENS_IDS)[number];

export function isLensId(value: unknown): value is LensId {
  return typeof value === "string" && (LENS_IDS as readonly string[]).includes(value);
}

export interface LensDefinition {
  id: LensId;
  /** Short menu label ("ELI5"). */
  label: string;
  /** One-line hint shown under the label in the menu. */
  hint: string;
}

/** The lens catalogue, in menu order. */
export const LENSES: readonly LensDefinition[] = [
  { id: "eli5", label: "ELI5", hint: "Explain it like I'm five" },
  { id: "executive", label: "Executive summary", hint: "What changed and why it matters" },
  { id: "code-review", label: "Code review", hint: "Concrete issues, severity and fixes" },
  { id: "security", label: "Security audit", hint: "Risks, severity and mitigations" },
  { id: "architecture", label: "Architecture diagram", hint: "Mermaid diagram of the design" },
];

export function lensDefinition(id: LensId): LensDefinition {
  return LENSES.find((lens) => lens.id === id) ?? LENSES[0];
}

/** One lens result as returned by the API and rendered by the UI. */
export interface LensResult {
  lens: LensId;
  /** The lens answer (markdown; the architecture lens emits a mermaid block). */
  text: string;
  /** Provider that served the call (never a key). */
  provider: string;
  /** Model that served the call. */
  model: string;
  /** Estimated cost in USD; null when the price is unknown. */
  costUsd: number | null;
  latencyMs: number;
  /** True when the answer came from the per-user cache. */
  cached: boolean;
  /** Epoch ms when the answer was produced. */
  createdAt: number;
}
