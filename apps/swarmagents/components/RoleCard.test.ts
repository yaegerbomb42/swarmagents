import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoleCard } from "./RoleCard";
import type { RoleDefinition } from "@/lib/roles";

const mockRole: RoleDefinition = {
  id: "test-role",
  name: "Test Role",
  description: "Test description",
  glyph: "🧪",
  category: "coding",
  model: "claude-3-7-sonnet",
  builtin: false,
  permissions: {
    terminal: true,
    fileSystem: true,
    browser: false,
    mcp: true,
    git: true,
  },
  tools: ["read_file", "write_file"],
  mcpServers: [],
  skills: [],
};

test("RoleCard renders without nested interactive controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(RoleCard, {
      role: mockRole,
      active: false,
      onSelect: () => {},
      onEdit: () => {},
      onDuplicate: () => {},
      onDelete: () => {},
    })
  );

  // Article must NOT have role="button" or tabIndex (must not be an interactive parent)
  assert.doesNotMatch(html, /<article[^>]*role="button"/);
  assert.doesNotMatch(html, /<article[^>]*tabindex/i);

  // Selection must be a native button sibling to the action buttons
  assert.match(html, /<button[^>]*>Select<\/button>/);
  assert.match(html, /<button[^>]*>Edit<\/button>/);
  assert.match(html, /<button[^>]*>Duplicate<\/button>/);
  assert.match(html, /<button[^>]*>Delete<\/button>/);
});

test("RoleCard displays 'Selected' when active", () => {
  const html = renderToStaticMarkup(
    React.createElement(RoleCard, {
      role: mockRole,
      active: true,
      onSelect: () => {},
    })
  );

  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*>Selected<\/button>/);
});
