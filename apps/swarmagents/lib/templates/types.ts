/**
 * Template gallery types (dependency-free).
 *
 * A template is a ready-made task for the agent: a title, a one-line pitch,
 * a fully written prompt with {{variable}} placeholders, the form fields that
 * fill those placeholders, the role that should run it, how long it usually
 * takes, the tools it needs, and a written example of what "done" looks like.
 *
 * This module is deliberately free of runtime dependencies (no zod, no React,
 * no node:*) so the browser bundle and the server can share it. The zod
 * schema that validates the data lives in ./schema.ts and is only used by the
 * server and the tests.
 */

/** The eight gallery categories. */
export const TEMPLATE_CATEGORIES = [
  "build-an-app",
  "fix-or-refactor-code",
  "research-and-reports",
  "data-and-spreadsheets",
  "web-automation-in-the-vm-browser",
  "devops-and-servers",
  "content-and-docs",
  "personal-productivity",
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Human label + blurb for a category, shown above the grid. */
export interface TemplateCategoryInfo {
  id: TemplateCategory;
  label: string;
  blurb: string;
}

/** The kind of input a variable field collects. */
export type TemplateFieldType = "text" | "textarea" | "select";

/** One form field of a template; its `name` matches a {{variable}} in the prompt. */
export interface TemplateField {
  /** Variable name, used verbatim as {{name}} in the prompt. */
  name: string;
  /** Label shown above the input. */
  label: string;
  type: TemplateFieldType;
  /** Placeholder text for the input (text/textarea). */
  placeholder?: string;
  /** Pre-filled value the user can overwrite. */
  default?: string;
  /** Allowed values (select fields only). */
  options?: string[];
  /** One line of help text under the input. */
  help?: string;
}

/** A single gallery template. */
export interface TaskTemplate {
  /** Stable kebab-case id, unique across the gallery. */
  id: string;
  category: TemplateCategory;
  title: string;
  /** One sentence: what the user gets. */
  pitch: string;
  /** The full prompt sent to the agent, with {{variable}} placeholders. */
  prompt: string;
  /** Form fields; every {{variable}} in `prompt` has exactly one field. */
  fields: TemplateField[];
  /** Role id (see lib/roles.ts) that should run this template. */
  role: string;
  /** Rough wall-clock estimate in minutes. */
  estimatedMinutes: number;
  /** Agent tools the template expects (bash, write_file, browser, ...). */
  tools: string[];
  /** MCP servers the template expects (github-mcp, postgres-mcp, ...). */
  mcp: string[];
  /** A written example of the finished output — never placeholder text. */
  example: string;
}
