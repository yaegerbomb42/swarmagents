/**
 * The catalog endpoint returns the whole gallery. It is static content, so
 * this test is about the shape the browser depends on: 60 templates, each
 * with the fields the drawer renders.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "./route";
import { TEMPLATES } from "../../../lib/templates";

test("GET /api/templates returns every template and the categories", async () => {
  const res = await GET();
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    templates: Array<{
      id: string;
      title: string;
      pitch: string;
      prompt: string;
      fields: Array<{ name: string; label: string; type: string }>;
      role: string;
      estimatedMinutes: number;
      tools: string[];
      mcp: string[];
      example: string;
      category: string;
    }>;
    categories: Array<{ id: string; label: string; blurb: string }>;
  };

  assert.equal(body.templates.length, 60);
  assert.equal(body.templates.length, TEMPLATES.length);
  assert.equal(body.categories.length, 8);

  for (const template of body.templates) {
    assert.ok(template.id.length > 0);
    assert.ok(template.title.length > 0);
    assert.ok(template.pitch.length > 0);
    assert.ok(template.prompt.length > 0);
    assert.ok(template.example.length > 0);
    assert.ok(template.role.length > 0);
    assert.ok(template.estimatedMinutes > 0);
    assert.ok(Array.isArray(template.tools));
    assert.ok(Array.isArray(template.mcp));
    for (const field of template.fields) {
      assert.ok(field.name.length > 0);
      assert.ok(field.label.length > 0);
      assert.ok(["text", "textarea", "select"].includes(field.type));
    }
  }

  for (const category of body.categories) {
    assert.ok(category.label.length > 0);
    assert.ok(category.blurb.length > 0);
  }
});

test("the catalog endpoint sends no cacheable-store secrets", async () => {
  const res = await GET();
  const text = await res.text();
  // Provider key shapes, not the letters "sk" inside an ordinary word.
  assert.ok(!/sk-[A-Za-z0-9_-]{12,}/.test(text), "the catalog must not carry any key material");
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{12,}/.test(text), "the catalog must not carry a bearer token");
});
