/**
 * Zod schema for the template gallery.
 *
 * The gallery data in ./data/*.ts is static content that ships with the app,
 * so the schema is the contract that keeps it honest: every template is
 * validated once at import time, and the tests re-validate the whole set.
 *
 * The schema also enforces the rule that makes the gallery usable: every
 * {{variable}} placeholder in a prompt has a matching form field, and every
 * field is used by the prompt. A template with an unfillable placeholder
 * would send a literal "{{thing}}" to the agent, so it is rejected here
 * instead of at run time.
 */

import { z } from "zod";
import { TEMPLATE_CATEGORIES } from "./types";

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/** A single form field. */
export const templateFieldSchema = z.object({
  name: z.string().regex(VARIABLE_NAME, "field names must be lowercase snake_case"),
  label: z.string().min(1),
  type: z.enum(["text", "textarea", "select"]),
  placeholder: z.string().optional(),
  default: z.string().optional(),
  options: z.array(z.string().min(1)).optional(),
  help: z.string().optional(),
});

/** One gallery template. */
export const taskTemplateSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "template ids must be kebab-case"),
  category: z.enum(TEMPLATE_CATEGORIES),
  title: z.string().min(3),
  pitch: z.string().min(10),
  prompt: z.string().min(40),
  fields: z.array(templateFieldSchema).max(12),
  role: z.string().min(1),
  estimatedMinutes: z.number().int().positive(),
  tools: z.array(z.string().min(1)).min(1),
  mcp: z.array(z.string().min(1)),
  example: z.string().min(40),
});

export type TaskTemplateInput = z.infer<typeof taskTemplateSchema>;

/** Every {{variable}} mentioned in a prompt, in order of first appearance. */
export function promptVariables(prompt: string): string[] {
  const found: string[] = [];
  for (const match of prompt.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const name = match[1];
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Validate one template against the schema plus the placeholder/field rule.
 * Returns a list of human-readable problems (empty when the template is fine).
 */
export function validateTemplate(input: unknown): string[] {
  const parsed = taskTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const template = parsed.data;
  const problems: string[] = [];

  const variables = promptVariables(template.prompt);
  const fieldNames = template.fields.map((field) => field.name);

  for (const name of variables) {
    if (!fieldNames.includes(name)) problems.push(`prompt uses {{${name}}} but no field provides it`);
  }
  for (const name of fieldNames) {
    if (!variables.includes(name)) problems.push(`field "${name}" is never used by the prompt`);
  }
  if (new Set(fieldNames).size !== fieldNames.length) problems.push("field names must be unique");
  for (const field of template.fields) {
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      problems.push(`field "${field.name}" is a select but has no options`);
    }
  }
  return problems;
}

/** Validate a whole gallery; returns a map of template id -> problems. */
export function validateTemplates(templates: readonly unknown[]): Map<string, string[]> {
  const problems = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const input of templates) {
    const id =
      typeof input === "object" && input !== null && typeof (input as { id?: unknown }).id === "string"
        ? (input as { id: string }).id
        : "(unknown)";
    const found = validateTemplate(input);
    if (seen.has(id)) found.push(`duplicate template id "${id}"`);
    seen.add(id);
    if (found.length > 0) problems.set(id, found);
  }
  return problems;
}
