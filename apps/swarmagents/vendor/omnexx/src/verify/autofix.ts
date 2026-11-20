import { ESLint } from 'eslint';

/** The result of a bounded in-process auto-fix attempt. */
export interface AutofixResult {
  fixed: boolean;
  content: string;
  rulesFixed: string[];
}

/** Time budget (ms) for one in-process ESLint auto-fix pass. */
export const AUTOFIX_TIMEOUT_MS = 1500;

/**
 * Fix categories we are willing to apply automatically. `suggestion` fixes are excluded on
 * purpose: they can change runtime behavior, while `problem` and `layout` fixes are
 * mechanical and safe to apply without human review.
 */
const FIX_TYPES: ('problem' | 'layout')[] = ['problem', 'layout'];

/** The subset of an ESLint message we care about. */
interface FixableMessage {
  ruleId: string | null;
  fix?: unknown;
}

/** The rule ids that reported at least one fixable problem. */
function fixableRuleIds(messages: readonly FixableMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.ruleId !== null && message.fix !== undefined) ids.add(message.ruleId);
  }
  return ids;
}

/**
 * Try to auto-fix `source` once against the project-local ESLint configuration rooted at
 * `root`. Throws on any ESLint failure; callers are expected to degrade gracefully.
 */
async function fixOnce(root: string, filePath: string, source: string): Promise<AutofixResult> {
  const unchanged: AutofixResult = { fixed: false, content: source, rulesFixed: [] };

  // Probe first: which rules report a fixable problem? (fix is disabled on this pass).
  const probe = new ESLint({ cwd: root });
  const probeResults = await probe.lintText(source, { filePath });
  const probeResult = probeResults[0];
  if (probeResult === undefined) return unchanged;
  const before = fixableRuleIds(probeResult.messages);
  if (before.size === 0) return unchanged;

  // Apply only the safe fix categories.
  const fixer = new ESLint({ cwd: root, fix: true, fixTypes: FIX_TYPES });
  const fixResults = await fixer.lintText(source, { filePath });
  const fixResult = fixResults[0];
  if (fixResult === undefined) return unchanged;

  const fixedContent = fixResult.output;
  if (fixedContent === undefined || fixedContent === source) return unchanged;

  // Rules whose fixable problems disappeared after the fix pass are the ones actually fixed.
  const after = fixableRuleIds(fixResult.messages);
  const rulesFixed = [...before].filter((rule) => !after.has(rule)).sort();

  return { fixed: true, content: fixedContent, rulesFixed };
}

/** Resolves to `fallback` if `task` does not settle within `ms` milliseconds. */
function withTimeout<T>(ms: number, task: () => Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    task().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

/**
 * Auto-fix `source` in-process with the project-local ESLint configuration rooted at `root`.
 *
 * Only mechanical (`problem`/`layout`) fixes are applied; suggestions are left for the model
 * to review. The whole attempt runs under a {@link AUTOFIX_TIMEOUT_MS} budget — if ESLint
 * stalls or throws, we degrade gracefully to the original source with no rules fixed.
 */
export function runAutofix(root: string, filePath: string, source: string): Promise<AutofixResult> {
  const fallback: AutofixResult = { fixed: false, content: source, rulesFixed: [] };
  return withTimeout(AUTOFIX_TIMEOUT_MS, () => fixOnce(root, filePath, source), fallback);
}
