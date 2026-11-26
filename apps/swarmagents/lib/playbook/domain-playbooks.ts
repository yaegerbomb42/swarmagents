/**
 * Deterministic task-domain playbook detector and injector.
 *
 * Matches a user prompt against verified desktop/CLI domains (Blender, Docs,
 * Data, Media, Web) and emits a compact (<=250 token) environment hint block
 * so A1 does not waste turns discovering installed binaries or display flags.
 * Unrelated prompts receive an empty string (zero interference).
 */

export type TaskDomain = "blender" | "docs" | "data" | "media" | "web";

export const DEFAULT_PLAYBOOK_MAX_TOKENS = 250;

interface PlaybookEntry {
  domain: TaskDomain;
  pattern: RegExp;
  hint: string;
}

const PLAYBOOKS: readonly PlaybookEntry[] = [
  {
    domain: "blender",
    pattern: /\b(blender|\.blend|cycles|eevee|3d\s+(?:scene|render|model|mesh))\b/i,
    hint: "[Playbook: Blender] `blender` is installed. For headless renders use `blender --background --python script.py`; for live GUI use `DISPLAY=:1 blender`. Save outputs in `/workspace` and verify rendered images with `identify <file>`.",
  },
  {
    domain: "docs",
    pattern: /\b(libreoffice|spreadsheet|xlsx?|docx?|pptx?|pdf|slides|presentation|convert\s+to\s+pdf)\b/i,
    hint: "[Playbook: Docs] `libreoffice` and `poppler-utils` (`pdftotext`, `pdfinfo`) are installed. Convert files non-interactively with `libreoffice --headless --convert-to pdf --outdir /workspace <file>` or open GUI via `open_app(\"libreoffice\")` on `DISPLAY=:1`.",
  },
  {
    domain: "data",
    pattern: /\b(matplotlib|seaborn|pandas|csv|chart|plot|histogram|heatmap|dataframe|jupyter)\b/i,
    hint: "[Playbook: Data] `python3` with `matplotlib`/`python3-tk` is installed. Use `matplotlib.use(\"Agg\")` for headless PNG/SVG export to `/workspace`, or `DISPLAY=:1` for interactive windows; verify saved plots with `ls -lh` / `identify`.",
  },
  {
    domain: "media",
    pattern: /\b(ffmpeg|ffprobe|gimp|imagemagick|video\s+edit|resize\s+image|thumbnail|mp4|gif)\b/i,
    hint: "[Playbook: Media] `ffmpeg`, `imagemagick` (`convert`, `identify`), and `gimp` are installed. Pass `-y` to `ffmpeg` for non-interactive overwrites and verify outputs with `ffprobe` or `identify`.",
  },
  {
    domain: "web",
    pattern: /\b(playwright|scrape|crawl|website|web\s+page|browser|fill\s+(?:out|in)\s+(?:a\s+)?form|screenshot\s+(?:a\s+)?site)\b/i,
    hint: "[Playbook: Web] Prefer `playwright-mcp` (`browser_navigate`, `browser_snapshot`, `browser_click`) for structured DOM/text before falling back to `computer-mcp` `click_text`/`screenshot`. Chromium profile persists at `/workspace/.swarm/browser-profile`.",
  },
];

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/** Detect matching task domains for `prompt` in deterministic priority order. */
export function detectTaskDomains(prompt: string): TaskDomain[] {
  const input = typeof prompt === "string" ? prompt : "";
  if (!input.trim()) return [];
  return PLAYBOOKS.filter((entry) => entry.pattern.test(input)).map((entry) => entry.domain);
}

/**
 * Build a compact domain playbook block capped at `maxTokens` (default 250).
 * Returns empty text and `domains: []` when no domain matches.
 */
export function buildDomainPlaybook(
  prompt: string,
  maxTokens: number = DEFAULT_PLAYBOOK_MAX_TOKENS,
): { domains: TaskDomain[]; text: string; estimatedTokens: number } {
  const matched = PLAYBOOKS.filter((entry) => entry.pattern.test(prompt || ""));
  if (matched.length === 0 || maxTokens <= 0) {
    return { domains: [], text: "", estimatedTokens: 0 };
  }

  const maxChars = Math.max(0, Math.floor(maxTokens) * 4);
  const domains: TaskDomain[] = [];
  const lines: string[] = [];

  for (const entry of matched) {
    const candidate = [...lines, entry.hint].join("\n");
    if (candidate.length <= maxChars) {
      domains.push(entry.domain);
      lines.push(entry.hint);
    } else if (lines.length === 0) {
      // Single matched playbook exceeded budget: truncate cleanly at char cap.
      const clipped = `${entry.hint.slice(0, Math.max(0, maxChars - 1))}…`;
      domains.push(entry.domain);
      lines.push(clipped);
      break;
    } else {
      break;
    }
  }

  const text = lines.join("\n");
  return { domains, text, estimatedTokens: estimateTokens(text) };
}
