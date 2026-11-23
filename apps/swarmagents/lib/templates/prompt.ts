/**
 * Template prompt helpers (dependency-free).
 *
 * These are used by both the browser (to preview a filled prompt) and the
 * server (to render the prompt a run actually receives), so they live in
 * their own module that pulls in no template data.
 */

import type { TaskTemplate, TemplateField } from "./types";

/**
 * Fill a template's prompt with the user's answers.
 *
 * Every {{variable}} in the prompt is replaced with the value for that field.
 * A field the user left blank keeps its default; a variable with no value at
 * all is replaced by an empty string, so the agent never sees a literal
 * "{{placeholder}}".
 */
export function renderPrompt(template: TaskTemplate, values: Record<string, string>): string {
  return template.prompt.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    // Only an own property counts as an answer; inherited properties are not
    // user input. A blank answer falls through to the field's initial value.
    if (Object.hasOwn(values, name)) {
      const value = values[name];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    const field = template.fields.find((candidate) => candidate.name === name);
    // fieldInitialValue also covers select fields without an explicit default:
    // they start at their first option instead of rendering as "".
    return field ? fieldInitialValue(field) : "";
  });
}

/**
 * The values a form starts with: each field's default, or its first option
 * for a select field.
 */
export function initialValues(template: TaskTemplate): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of template.fields) {
    values[field.name] = fieldInitialValue(field);
  }
  return values;
}

/** The starting value of one field: its default, or the first select option. */
export function fieldInitialValue(field: TemplateField): string {
  if (field.default !== undefined) return field.default;
  if (field.type === "select" && field.options && field.options.length > 0) return field.options[0];
  return "";
}
