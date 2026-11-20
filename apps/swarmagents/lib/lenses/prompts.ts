/**
 * The lens prompts.
 *
 * Every lens is a short, specialised system prompt: the agent's message is
 * re-read through one lens and the answer comes back as short markdown. The
 * architecture lens is the only one that must emit a mermaid diagram.
 *
 * The message and any referenced files are capped before they reach a
 * provider: a lens is a summary of a message, not a second copy of the whole
 * run, and lenses run on the cheapest capable model.
 */

/** One file the agent referenced (a diff hunk or a file it wrote). */
export interface ReferencedFile {
  /** Path shown to the model, e.g. "src/app.ts". */
  path: string;
  /** File content (already capped by the caller where possible). */
  content: string;
}

/** Max characters of the agent message that reach the model. */
export const MAX_MESSAGE_CHARS = 12_000;

/** Max referenced files that reach the model. */
export const MAX_FILES = 5;

/** Max characters per referenced file. */
export const MAX_FILE_CHARS = 4_000;

/** Max characters of referenced-file context in total. */
export const MAX_CONTEXT_CHARS = 20_000;

/** System prompt per lens. */
export const LENS_SYSTEM_PROMPTS: Record<string, string> = {
  eli5: [
    "You explain an agent's answer to a curious 5-year-old.",
    "Rules: plain words only, no jargon, no acronyms without spelling them out.",
    "Answer with 3 short bullets and one one-line analogy. Never mention that you are an AI.",
  ].join(" "),
  executive: [
    "You summarise an agent's answer for an executive who has 30 seconds.",
    "Rules: at most 3 bullets — what changed, why it matters, what to do next.",
    "No jargon, no code, under 120 words. Lead with the decision, not the background.",
  ].join(" "),
  "code-review": [
    "You are a pragmatic senior engineer reviewing the code shown in the message.",
    "Rules: list concrete issues only, each as `- [blocker|major|minor] file:line — issue — one-line fix`.",
    "Reference a file and line when the context shows one. Do not invent findings; if the code is fine, say so in one line.",
  ].join(" "),
  security: [
    "You are a security engineer auditing the code and output shown in the message.",
    "Rules: list findings as `- [critical|high|medium|low] issue — impact — fix`.",
    "Look for secrets in code, injection, broken authz, unsafe input handling and unsafe defaults. Say 'No issues found' when it is clean.",
  ].join(" "),
  architecture: [
    "You draw the architecture described by the message and the referenced files.",
    "Rules: output ONLY one mermaid code block, no prose before or after it.",
    "The block must start with `flowchart TD` (or `flowchart LR`).",
    "Use short node ids and readable labels in square brackets, e.g. `A[Browser]`.",
    "Label the important edges with `-->|label|`. Use at most 12 nodes.",
  ].join(" "),
};

/** The system prompt for one lens. */
export function lensSystemPrompt(lens: string): string {
  return LENS_SYSTEM_PROMPTS[lens] ?? LENS_SYSTEM_PROMPTS.eli5;
}

/** Truncate text to a cap, marking the cut so the model knows it is partial. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated)`;
}

/**
 * Keep only the first MAX_FILES referenced files, cap each one, and stop once
 * the total context budget is used up.
 */
export function capFiles(files: readonly ReferencedFile[] | undefined): ReferencedFile[] {
  if (!files || files.length === 0) return [];
  const capped: ReferencedFile[] = [];
  let total = 0;
  for (const file of files) {
    if (capped.length >= MAX_FILES) break;
    const content = capText(file.content ?? "", MAX_FILE_CHARS);
    if (!content.trim()) continue;
    const room = MAX_CONTEXT_CHARS - total;
    if (room <= 0) break;
    const slice = content.length > room ? capText(content.slice(0, room), room) : content;
    capped.push({ path: file.path, content: slice });
    total += slice.length;
  }
  return capped;
}

/**
 * Build the user turn for a lens: the agent's message, then the referenced
 * files it talked about (a diff hunk or a file it wrote).
 */
export function buildLensUserMessage(input: {
  message: string;
  files?: readonly ReferencedFile[];
}): string {
  const message = capText(input.message ?? "", MAX_MESSAGE_CHARS);
  const files = capFiles(input.files);
  if (files.length === 0) return message;
  const blocks = files.map(
    (file) => `--- ${file.path} ---\n${file.content}`,
  );
  return `${message}\n\n<referenced_files>\n${blocks.join("\n\n")}\n</referenced_files>`;
}
