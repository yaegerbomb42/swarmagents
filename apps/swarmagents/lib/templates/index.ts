/**
 * The template gallery.
 *
 * Static content: 60 task templates across 8 categories, each with a fully
 * written prompt, the form fields that fill its {{variables}}, a recommended
 * role, an estimate, the tools it needs and an example of the finished work.
 *
 * Nothing here is user data and nothing here talks to the network — the
 * gallery is the same for every account, and it is imported by both the
 * server (for the /templates page) and the browser (for the picker).
 */

import type { TaskTemplate, TemplateCategory, TemplateCategoryInfo, TemplateField } from "./types";
import { renderPrompt } from "./prompt";
import { BUILD_AN_APP } from "./data/build-an-app";
import { FIX_OR_REFACTOR_CODE } from "./data/fix-or-refactor-code";
import { RESEARCH_AND_REPORTS } from "./data/research-and-reports";
import { DATA_AND_SPREADSHEETS } from "./data/data-and-spreadsheets";
import { WEB_AUTOMATION_IN_THE_VM_BROWSER } from "./data/web-automation-in-the-vm-browser";
import { DEVOPS_AND_SERVERS } from "./data/devops-and-servers";
import { CONTENT_AND_DOCS } from "./data/content-and-docs";
import { PERSONAL_PRODUCTIVITY } from "./data/personal-productivity";

export type { TaskTemplate, TemplateCategory, TemplateCategoryInfo, TemplateField } from "./types";
export { TEMPLATE_CATEGORIES } from "./types";
export { renderPrompt, initialValues, fieldInitialValue } from "./prompt";

/** Label and blurb for each category, in gallery order. */
export const CATEGORY_INFO: readonly TemplateCategoryInfo[] = [
  {
    id: "build-an-app",
    label: "Build an app",
    blurb: "APIs, CLIs, web apps and containers — from an empty directory to something that runs.",
  },
  {
    id: "fix-or-refactor-code",
    label: "Fix / refactor code",
    blurb: "A red test, a crash, a slow function or a messy module, with the cause named.",
  },
  {
    id: "research-and-reports",
    label: "Research and reports",
    blurb: "Comparisons, audits, teardowns and explanations — with sources, not guesses.",
  },
  {
    id: "data-and-spreadsheets",
    label: "Data and spreadsheets",
    blurb: "Clean, join, validate and report on data without losing a row on the way.",
  },
  {
    id: "web-automation-in-the-vm-browser",
    label: "Web automation",
    blurb: "The agent drives the real browser in its own VM: forms, scraping, checks, flows.",
  },
  {
    id: "devops-and-servers",
    label: "DevOps and servers",
    blurb: "Provisioning, deploys, monitoring and hardening for a machine you actually run.",
  },
  {
    id: "content-and-docs",
    label: "Content and docs",
    blurb: "READMEs, API docs, tutorials and release notes that someone can follow.",
  },
  {
    id: "personal-productivity",
    label: "Personal productivity",
    blurb: "Plan the week, write the update, prepare for the meeting, tidy the folder.",
  },
];

/** Every template in the gallery. */
export const TEMPLATES: readonly TaskTemplate[] = [
  ...BUILD_AN_APP,
  ...FIX_OR_REFACTOR_CODE,
  ...RESEARCH_AND_REPORTS,
  ...DATA_AND_SPREADSHEETS,
  ...WEB_AUTOMATION_IN_THE_VM_BROWSER,
  ...DEVOPS_AND_SERVERS,
  ...CONTENT_AND_DOCS,
  ...PERSONAL_PRODUCTIVITY,
];

/** The template with this id, or undefined. */
export function findTemplate(id: string): TaskTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/** Templates in one category, in gallery order. */
export function templatesInCategory(category: TemplateCategory): TaskTemplate[] {
  return TEMPLATES.filter((template) => template.category === category);
}

/** How many templates each category holds. */
export function categoryCounts(): Map<TemplateCategory, number> {
  const counts = new Map<TemplateCategory, number>();
  for (const template of TEMPLATES) {
    counts.set(template.category, (counts.get(template.category) ?? 0) + 1);
  }
  return counts;
}

/**
 * Filter and rank templates for the gallery.
 *
 * A query matches the title, pitch, category label or prompt (case
 * insensitive). With no query every template in the category is returned, in
 * gallery order.
 */
export function searchTemplates(
  query: string,
  category?: TemplateCategory | "all",
): TaskTemplate[] {
  const pool =
    category && category !== "all"
      ? TEMPLATES.filter((template) => template.category === category)
      : TEMPLATES;

  const needle = query.trim().toLowerCase();
  if (!needle) return [...pool];

  const terms = needle.split(/\s+/).filter(Boolean);
  return pool.filter((template) => {
    const label =
      CATEGORY_INFO.find((info) => info.id === template.category)?.label.toLowerCase() ?? "";
    const haystack = [template.title, template.pitch, label, template.prompt]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
