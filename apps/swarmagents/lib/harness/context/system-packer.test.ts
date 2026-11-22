/**
 * Tests for the system-prompt section packer + cache-friendly ordering
 * (lib/harness/context/system-packer.ts): budget caps, value-density
 * ranking, protected sections, the stable-prefix property of the ordered
 * emission, and byte-identical reconstruction of the legacy join.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../../codebase/tokens";
import {
  DEFAULT_SYSTEM_BUDGET_TOKENS,
  joinSystemSections,
  orderSystemSections,
  packSystemSections,
  resolveSystemBudget,
  splitCodebasePack,
  systemSectionsFrom,
} from "./system-packer";

/** A block of filler prose of roughly `tokens` estimated tokens. */
function filler(label: string, tokens: number): string {
  const line = `${label} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod`;
  const lines: string[] = [];
  while (estimateTokens(lines.join("\n")) < tokens) lines.push(line);
  return lines.join("\n");
}

const PACK = `<codebase_context repo_hash="abc123">\n${filler("codebase", 300)}\n</codebase_context>`;
const CARD = "You are a careful coding agent. Prefer small diffs.";
const ROLE = "Role: coder. Use the tools you are given.";
const MEMORY = `- the user prefers pnpm\n- deploy target is the VPS`;

function legacyJoin(parts: { agentCard?: string; rolePrompt?: string; memoryContext?: string }): string {
  return [parts.agentCard, parts.rolePrompt, parts.memoryContext].filter(Boolean).join("\n\n");
}

test("splitCodebasePack splits the wrapped pack from the card, and only at the front", () => {
  const { pack, card } = splitCodebasePack(`${PACK}\n\n${CARD}`);
  assert.equal(pack, PACK);
  assert.equal(card, CARD);
  assert.deepEqual(splitCodebasePack(CARD), { card: CARD });
  assert.deepEqual(splitCodebasePack(PACK), { pack: PACK, card: "" });
  // A marker mid-text is content, not a pack boundary.
  const mid = `intro\n${PACK}`;
  assert.deepEqual(splitCodebasePack(mid), { card: mid });
});

test("sections reproduce the legacy appended prompt byte-for-byte when nothing is cut", () => {
  const parts = { agentCard: `${PACK}\n\n${CARD}`, rolePrompt: ROLE, memoryContext: MEMORY };
  const sections = systemSectionsFrom(parts);
  assert.deepEqual(
    sections.map((s) => s.id),
    ["codebase", "agent-card", "role", "memory"],
  );
  assert.equal(joinSystemSections(sections), legacyJoin(parts));

  const packed = packSystemSections(sections, DEFAULT_SYSTEM_BUDGET_TOKENS);
  assert.equal(packed.text, legacyJoin(parts));
  assert.deepEqual(packed.truncated, []);
  assert.ok(packed.totalTokens <= packed.budgetTokens);
});

test("sections handle missing parts like the legacy join does", () => {
  assert.equal(joinSystemSections(systemSectionsFrom({})), "");
  assert.equal(
    joinSystemSections(systemSectionsFrom({ agentCard: CARD })),
    legacyJoin({ agentCard: CARD }),
  );
  assert.equal(
    joinSystemSections(systemSectionsFrom({ rolePrompt: ROLE, memoryContext: MEMORY })),
    legacyJoin({ rolePrompt: ROLE, memoryContext: MEMORY }),
  );
});

test("packer hard-caps the total and sacrifices lowest-value sections first", () => {
  const sections = systemSectionsFrom({
    agentCard: `<codebase_context>\n${filler("codebase", 4000)}\n</codebase_context>\n\n${CARD}`,
    rolePrompt: ROLE,
    memoryContext: filler("memory", 2000),
  });
  const packed = packSystemSections(sections, 3000);
  assert.ok(packed.totalTokens <= 3000, `total ${packed.totalTokens} over budget`);
  const byId = new Map(packed.usage.map((u) => [u.id, u]));
  // Memory (least dense) is squeezed out entirely; the codebase pack keeps
  // most of its bytes.
  assert.equal(byId.get("memory")?.used, 0);
  assert.ok((byId.get("codebase")?.used ?? 0) > 2000);
  assert.ok(packed.truncated.includes("memory"));
  // Protected sections are intact.
  assert.equal(byId.get("agent-card")?.used, byId.get("agent-card")?.before);
  assert.equal(byId.get("role")?.used, byId.get("role")?.before);
  assert.ok(packed.text.includes(CARD));
  assert.ok(packed.text.includes(ROLE));
});

test("packer fills denser sections first: codebase keeps budget that memory loses", () => {
  const sections = systemSectionsFrom({
    agentCard: `<codebase_context>\n${filler("codebase", 1500)}\n</codebase_context>\n\n${CARD}`,
    rolePrompt: ROLE,
    memoryContext: filler("memory", 1500),
  });
  // Room for protected + codebase, not for memory.
  const packed = packSystemSections(sections, 2000);
  const byId = new Map(packed.usage.map((u) => [u.id, u]));
  assert.equal(byId.get("codebase")?.truncated, false);
  assert.equal(byId.get("memory")?.truncated, true);
});

test("protected sections alone over budget are returned intact (fail-open)", () => {
  const bigCard = filler("card", 5000);
  const sections = systemSectionsFrom({
    agentCard: bigCard,
    rolePrompt: ROLE,
    memoryContext: filler("memory", 500),
  });
  const packed = packSystemSections(sections, 1000);
  // The card is never cut, even though it busts the budget on its own.
  assert.ok(packed.text.includes(bigCard));
  assert.ok(packed.text.includes(ROLE));
  // The truncatable section is dropped instead.
  assert.deepEqual(packed.truncated, ["memory"]);
  assert.ok(!packed.text.includes("memory lorem"));
});

test("packer tolerates junk budgets and empty input", () => {
  assert.equal(resolveSystemBudget(undefined), DEFAULT_SYSTEM_BUDGET_TOKENS);
  assert.equal(resolveSystemBudget(0), DEFAULT_SYSTEM_BUDGET_TOKENS);
  assert.equal(resolveSystemBudget(Number.NaN), DEFAULT_SYSTEM_BUDGET_TOKENS);
  assert.equal(resolveSystemBudget(5), 1000);
  assert.equal(resolveSystemBudget(10_000_000), 200_000);
  const empty = packSystemSections([], 1000);
  assert.equal(empty.text, "");
  assert.equal(empty.totalTokens, 0);
  assert.deepEqual(empty.truncated, []);
});

test("cache-friendly order is stable-first and deterministic", () => {
  const sections = systemSectionsFrom({
    agentCard: `${PACK}\n\n${CARD}`,
    rolePrompt: ROLE,
    memoryContext: MEMORY,
  });
  const ordered = orderSystemSections(sections);
  assert.deepEqual(
    ordered.map((s) => s.id),
    ["role", "agent-card", "codebase", "memory"],
  );
  // Same input → same bytes, every time.
  assert.equal(joinSystemSections(orderSystemSections(sections)), joinSystemSections(ordered));
});

test("stable-prefix property: changing only memory leaves the ordered prefix untouched", () => {
  const base = systemSectionsFrom({
    agentCard: `${PACK}\n\n${CARD}`,
    rolePrompt: ROLE,
    memoryContext: MEMORY,
  });
  const changed = systemSectionsFrom({
    agentCard: `${PACK}\n\n${CARD}`,
    rolePrompt: ROLE,
    memoryContext: "- a brand new fact learned yesterday",
  });
  const a = joinSystemSections(orderSystemSections(base));
  const b = joinSystemSections(orderSystemSections(changed));
  // The prefix up to the memory section is identical, so a provider prompt
  // cache keyed on the prefix still hits.
  const prefix = `${ROLE}\n\n${CARD}\n\n${PACK}`;
  assert.ok(a.startsWith(prefix));
  assert.ok(b.startsWith(prefix));
  assert.notEqual(a, b);
});

test("stable-prefix property: a repo change busts only from the codebase pack onward", () => {
  const newPack = `<codebase_context repo_hash="def456">\n${filler("codebase2", 300)}\n</codebase_context>`;
  const a = joinSystemSections(
    orderSystemSections(
      systemSectionsFrom({ agentCard: `${PACK}\n\n${CARD}`, rolePrompt: ROLE, memoryContext: MEMORY }),
    ),
  );
  const b = joinSystemSections(
    orderSystemSections(
      systemSectionsFrom({ agentCard: `${newPack}\n\n${CARD}`, rolePrompt: ROLE, memoryContext: MEMORY }),
    ),
  );
  const stableHead = `${ROLE}\n\n${CARD}`;
  assert.ok(a.startsWith(stableHead));
  assert.ok(b.startsWith(stableHead));
  assert.notEqual(a, b);
});

test("log line reports per-section usage and truncations", () => {
  const sections = systemSectionsFrom({
    agentCard: `<codebase_context>\n${filler("codebase", 4000)}\n</codebase_context>\n\n${CARD}`,
    rolePrompt: ROLE,
    memoryContext: filler("memory", 2000),
  });
  const packed = packSystemSections(sections, 3000);
  assert.match(packed.logLine, /^system-packer budget=3000 total=\d+ /);
  assert.match(packed.logLine, /truncated=codebase,memory/);
});
