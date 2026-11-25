/**
 * Connector hub catalog invariants: every entry must be real, reachable, and
 * connectable — a catalog row is a promise that 1-click connect works.
 * A failure here means someone added a row the backend cannot actually wire
 * into a VM run (unknown MCP id, dead docs link, or a field the store cannot
 * map onto the server's required secrets).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  findCatalogConnector,
} from "./catalog";
import { connectorById } from "../library/catalog";

test("connector ids are unique and the catalog is large", () => {
  const ids = CONNECTOR_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "connector ids must be unique");
  assert.ok(
    CONNECTOR_CATALOG.length >= 30,
    `catalog should stay large, got ${CONNECTOR_CATALOG.length} entries`,
  );
});

test("every catalog entry is well-formed", () => {
  const categoryIds = new Set(CONNECTOR_CATEGORIES.map((category) => category.id));
  for (const entry of CONNECTOR_CATALOG) {
    assert.ok(entry.name.trim(), `${entry.id}: name`);
    assert.ok(entry.vendor.trim(), `${entry.id}: vendor`);
    assert.ok(entry.description.trim(), `${entry.id}: description`);
    assert.ok(entry.unlocks.trim(), `${entry.id}: unlocks`);
    assert.ok(entry.badges.length > 0, `${entry.id}: at least one badge`);
    assert.ok(
      entry.docsUrl.startsWith("https://"),
      `${entry.id}: docsUrl must be https, got ${entry.docsUrl}`,
    );
    assert.ok(categoryIds.has(entry.category), `${entry.id}: unknown category ${entry.category}`);
    assert.ok(
      entry.accent.startsWith("#") && [4, 7].includes(entry.accent.length),
      `${entry.id}: accent must be a hex color, got ${entry.accent}`,
    );
    for (const field of entry.fields) {
      assert.ok(field.key.trim(), `${entry.id}: field key`);
      assert.ok(field.label.trim(), `${entry.id}: field label for ${field.key}`);
      if (field.secret) {
        assert.ok(
          field.helpUrl?.startsWith("https://"),
          `${entry.id}: secret field ${field.key} needs an https helpUrl`,
        );
      }
    }
  }
});

test("every entry's MCP server exists in the verified library catalog", () => {
  for (const entry of CONNECTOR_CATALOG) {
    if (!entry.libraryConnectorId) continue;
    const libraryEntry = connectorById(entry.libraryConnectorId);
    assert.ok(
      libraryEntry,
      `${entry.id}: libraryConnectorId "${entry.libraryConnectorId}" is not in the library catalog`,
    );
    // The store can only seal values for fields the MCP server declares.
    // A catalog field the server never reads would silently vanish.
    for (const field of entry.fields) {
      assert.ok(
        libraryEntry.requiredFields.some((required) => required.key === field.key) ||
          field.key === "token",
        `${entry.id}: field "${field.key}" is not a required field of MCP server "${entry.libraryConnectorId}"`,
      );
    }
  }
});

test("every category has at least one connector", () => {
  for (const category of CONNECTOR_CATEGORIES) {
    if (category.id === "all") continue;
    assert.ok(
      CONNECTOR_CATALOG.some((entry) => entry.category === category.id),
      `category "${category.id}" has no connectors`,
    );
  }
});

test("findCatalogConnector resolves every catalog id", () => {
  for (const entry of CONNECTOR_CATALOG) {
    assert.equal(findCatalogConnector(entry.id)?.id, entry.id);
  }
  assert.equal(findCatalogConnector("no-such-connector"), null);
});
