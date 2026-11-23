/**
 * The template gallery must stay honest: 60 real templates, every one of them
 * valid, every {{variable}} fillable, every id unique.
 *
 * These tests run over the whole catalog, so a broken template fails the build
 * rather than reaching a user.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_INFO,
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  categoryCounts,
  findTemplate,
  initialValues,
  renderPrompt,
  searchTemplates,
  templatesInCategory,
  type TaskTemplate,
} from "./index";
import { promptVariables, taskTemplateSchema, validateTemplate, validateTemplates } from "./schema";
import { BUILTIN_ROLE_IDS } from "../roles";

const EXPECTED_TEMPLATE_COUNT = 60;

test("the gallery holds exactly 60 templates", () => {
  assert.equal(TEMPLATES.length, EXPECTED_TEMPLATE_COUNT);
});

test("every template matches the zod schema", () => {
  for (const template of TEMPLATES) {
    const parsed = taskTemplateSchema.safeParse(template);
    assert.ok(
      parsed.success,
      `template ${template.id} failed the schema: ${parsed.success ? "" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
});

test("no template has a schema or placeholder problem", () => {
  const problems = validateTemplates(TEMPLATES);
  const entries = [...problems.entries()];
  assert.deepEqual(
    entries,
    [],
    `templates with problems: ${entries.map(([id, issues]) => `${id} -> ${issues.join("; ")}`).join(" | ")}`,
  );
});

test("template ids are unique", () => {
  const ids = TEMPLATES.map((template) => template.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("every {{variable}} in a prompt has a form field, and every field is used", () => {
  for (const template of TEMPLATES) {
    const variables = promptVariables(template.prompt);
    const fieldNames = template.fields.map((field) => field.name);
    for (const variable of variables) {
      assert.ok(
        fieldNames.includes(variable),
        `template ${template.id} uses {{${variable}}} but has no field for it`,
      );
    }
    for (const name of fieldNames) {
      assert.ok(
        variables.includes(name),
        `template ${template.id} has an unused field "${name}"`,
      );
    }
  }
});

test("every template names a role that exists in the role catalog", () => {
  for (const template of TEMPLATES) {
    assert.ok(
      BUILTIN_ROLE_IDS.has(template.role),
      `template ${template.id} names an unknown role "${template.role}"`,
    );
  }
});

test("every category has templates and a label", () => {
  const counts = categoryCounts();
  assert.equal(counts.size, TEMPLATE_CATEGORIES.length, "every category should be used");
  for (const category of TEMPLATE_CATEGORIES) {
    assert.ok(
      (counts.get(category) ?? 0) > 0,
      `category ${category} has no templates`,
    );
  }
  for (const info of CATEGORY_INFO) {
    assert.ok(info.label.length > 0, `category ${info.id} has no label`);
    assert.ok(info.blurb.length > 0, `category ${info.id} has no blurb`);
  }
});

test("every template has real content: a title, a pitch and a written example", () => {
  for (const template of TEMPLATES) {
    assert.ok(template.title.length >= 5, `template ${template.id} has a too-short title`);
    assert.ok(template.pitch.length >= 20, `template ${template.id} has a too-short pitch`);
    assert.ok(template.prompt.length >= 80, `template ${template.id} has a too-short prompt`);
    assert.ok(
      template.example.length >= 40,
      `template ${template.id} has no written example of the finished output`,
    );
    assert.ok(
      !/lorem ipsum|\bTBD\b|\bFIXME\b|\bplaceholder text\b|\byour example here\b/i.test(template.example),
      `template ${template.id} has placeholder text in its example`,
    );
    assert.ok(template.estimatedMinutes > 0, `template ${template.id} has no time estimate`);
    assert.ok(template.tools.length > 0, `template ${template.id} lists no tools`);
  }
});

test("field names are valid identifiers and select fields have options", () => {
  for (const template of TEMPLATES) {
    const names = template.fields.map((field) => field.name);
    assert.deepEqual([...new Set(names)], names, `template ${template.id} has duplicate field names`);
    for (const field of template.fields) {
      assert.match(field.name, /^[a-z][a-z0-9_]*$/, `template ${template.id} field "${field.name}" is not snake_case`);
      assert.ok(field.label.length > 0, `template ${template.id} field "${field.name}" has no label`);
      if (field.type === "select") {
        assert.ok((field.options ?? []).length > 0, `template ${template.id} select "${field.name}" has no options`);
      }
    }
  }
});

test("findTemplate and templatesInCategory find the right things", () => {
  const first = TEMPLATES[0];
  assert.equal(findTemplate(first.id)?.title, first.title);
  assert.equal(findTemplate("no-such-template"), undefined);

  const build = templatesInCategory("build-an-app");
  assert.ok(build.length > 0);
  for (const template of build) assert.equal(template.category, "build-an-app");
});

test("renderPrompt fills the variables and leaves no placeholder behind", () => {
  const template = findTemplate("rest-api-with-auth");
  assert.ok(template);
  const values = { ...initialValues(template), project_name: "ledger-api", resource: "invoices" };
  const rendered = renderPrompt(template, values);
  assert.ok(rendered.includes("ledger-api"), "the filled value should be in the prompt");
  assert.ok(rendered.includes("invoices"), "the filled value should be in the prompt");
  assert.ok(!/\{\{/.test(rendered), `the rendered prompt still has a placeholder: ${rendered}`);
});

test("renderPrompt falls back to the field default when an answer is blank", () => {
  const template = findTemplate("rest-api-with-auth");
  assert.ok(template);
  const rendered = renderPrompt(template, { ...initialValues(template), project_name: "   " });
  assert.ok(rendered.includes("notes-api"), "the field default should be used");
  assert.ok(!/\{\{/.test(rendered), "no placeholder should survive");
});

test("initialValues gives every field a starting value", () => {
  for (const template of TEMPLATES) {
    const values = initialValues(template);
    for (const field of template.fields) {
      assert.equal(typeof values[field.name], "string", `template ${template.id} field ${field.name} has no initial value`);
    }
  }
});

test("searchTemplates matches on the title, the pitch and the category", () => {
  assert.equal(searchTemplates("").length, TEMPLATES.length);
  assert.equal(searchTemplates("", "build-an-app").length, templatesInCategory("build-an-app").length);

  const byTitle = searchTemplates("audit a dependency");
  assert.ok(byTitle.length >= 1);
  assert.equal(byTitle[0].id, "audit-a-dependency");

  const byCategory = searchTemplates("productivity", "personal-productivity");
  assert.ok(byCategory.length >= 1);
  for (const template of byCategory) assert.equal(template.category, "personal-productivity");

  assert.equal(searchTemplates("zzzzz-nothing-matches-this").length, 0);
});

test("validateTemplate rejects a template whose placeholder has no field", () => {
  const broken = {
    id: "broken",
    category: "build-an-app",
    title: "Broken template",
    pitch: "A pitch long enough to pass the schema check.",
    prompt: "Do the thing with {{missing_field}} in it.",
    fields: [{ name: "other", label: "Other", type: "text" }],
    role: "main",
    estimatedMinutes: 5,
    tools: ["bash"],
    mcp: [],
    example: "An example long enough to pass the schema check for the example field.",
  };
  const problems = validateTemplate(broken);
  assert.ok(problems.some((problem) => problem.includes("missing_field")));
});

/** A minimal template that passes validateTemplate unless a test overrides it. */
function templateWith(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: "valid-template",
    category: "build-an-app",
    title: "Valid template",
    pitch: "A valid pitch long enough for the schema.",
    prompt: "Use {{flavor}} and write the result to {{output_path}}.",
    fields: [
      { name: "flavor", label: "Flavor", type: "select", options: ["vanilla", "chocolate"] },
      { name: "output_path", label: "Output path", type: "text", default: "/workspace/out.md" },
    ],
    role: "main",
    estimatedMinutes: 5,
    tools: ["bash"],
    mcp: [],
    example: "Wrote the result to /workspace/out.md with the vanilla choice.",
    ...overrides,
  };
}

test("renderPrompt uses the first select option when there is no answer or default", () => {
  const template = templateWith({
    id: "select-fallback",
    prompt: "Choose {{flavor}} for the build.",
    fields: [{ name: "flavor", label: "Flavor", type: "select", options: ["vanilla", "chocolate"] }],
  });

  assert.equal(renderPrompt(template, {}), "Choose vanilla for the build.");
  assert.equal(renderPrompt(template, { flavor: "" }), "Choose vanilla for the build.");
  assert.equal(renderPrompt(template, { flavor: "chocolate" }), "Choose chocolate for the build.");

  // An inherited property is not a user answer.
  const inherited = Object.create({ flavor: "chocolate" }) as Record<string, string>;
  assert.equal(renderPrompt(template, inherited), "Choose vanilla for the build.");
});

test("validateTemplates merges problems for duplicate template ids", () => {
  const first = templateWith({
    id: "duplicate-id",
    prompt: "Use {{flavor}} and {{output_path}}; also {{missing_first}}.",
  });
  const second = templateWith({
    id: "duplicate-id",
    prompt: "Use {{flavor}} and {{output_path}}; also {{missing_second}}.",
  });

  const problems = validateTemplates([first, second]);
  const issues = problems.get("duplicate-id");
  assert.ok(issues, "the duplicate id should have an entry");
  assert.ok(issues.some((problem) => problem.includes("missing_first")));
  assert.ok(issues.some((problem) => problem.includes("missing_second")));
  assert.ok(issues.some((problem) => problem.includes('duplicate template id "duplicate-id"')));
});

test("validateTemplates merges problems for missing template ids", () => {
  // Schema parsing stops at the id error, so give each template a second,
  // distinct schema problem to prove both entries survive the merge.
  const first = { ...templateWith({ title: "X" }), prompt: "Use {{flavor}} and {{output_path}}." };
  const second = { ...templateWith({ pitch: "short" }), prompt: "Use {{flavor}} and {{output_path}}." };
  delete (first as Partial<TaskTemplate>).id;
  delete (second as Partial<TaskTemplate>).id;

  const problems = validateTemplates([first, second]);
  assert.deepEqual([...problems.keys()], ["(unknown)"], "missing ids share one entry");
  const issues = problems.get("(unknown)");
  assert.ok(issues);
  assert.ok(issues.some((problem) => problem.includes("title")), "the first template's problem survived");
  assert.ok(issues.some((problem) => problem.includes("pitch")), "the second template's problem survived");
  assert.ok(
    issues.filter((problem) => problem.includes("template id is missing or not a string")).length >= 2,
    "both missing-id problems were recorded",
  );
});

test("validateTemplate rejects a select default that is not one of its options", () => {
  const bad = templateWith({
    prompt: "Choose {{flavor}} for the build and write the result out.",
    fields: [
      {
        name: "flavor",
        label: "Flavor",
        type: "select",
        options: ["vanilla", "chocolate"],
        default: "strawberry",
      },
    ],
  });
  const problems = validateTemplate(bad);
  assert.ok(
    problems.some(
      (problem) =>
        problem.includes('default "strawberry"') && problem.includes("not one of its options"),
    ),
    `expected an invalid-select-default problem, got: ${problems.join("; ")}`,
  );

  const good = templateWith({
    prompt: "Choose {{flavor}} for the build and write the result out.",
    fields: [
      {
        name: "flavor",
        label: "Flavor",
        type: "select",
        options: ["vanilla", "chocolate"],
        default: "chocolate",
      },
    ],
  });
  assert.deepEqual(validateTemplate(good), []);
});

test("the browser login template references a password environment variable, not a password", () => {
  const template = findTemplate("log-in-and-read-data");
  assert.ok(template);
  assert.ok(!template.fields.some((field) => field.name === "password"));
  assert.ok(!JSON.stringify(template).includes("hunter2"));
  const passwordEnv = template.fields.find((field) => field.name === "password_env");
  assert.ok(passwordEnv, "the template should ask for a password environment variable");
  assert.ok(template.prompt.includes("{{password_env}}"));
  assert.ok(!template.prompt.includes("{{password}}"));
});

test("read-the-git-history lists write_file because its prompt writes output_path", () => {
  const template = findTemplate("read-the-git-history");
  assert.ok(template);
  assert.ok(template.prompt.includes("{{output_path}}"));
  assert.ok(template.tools.includes("write_file"));
});
