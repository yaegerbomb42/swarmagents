import test from "node:test";
import assert from "node:assert/strict";
import { verifyPhase, executeWithPhaseVerification } from "./verification.js";

test("verifyPhase parses compliant JSON and passes", async () => {
  const mockLLM = async () =>
    JSON.stringify({
      passed: true,
      score: 98,
      violations: [],
      remediationPrompt: "",
    });

  const res = await verifyPhase(
    {
      taskType: "recipe",
      phase: "semantic_acceptance",
      prompt: "Create gluten-free banana bread",
      constraints: ["No wheat flour", "Include baking temperature"],
      output: "Ingredients: Almond flour, bananas, eggs. Bake at 350F for 45 min.",
    },
    mockLLM
  );

  assert.equal(res.passed, true);
  assert.equal(res.violations.length, 0);
  assert.equal(res.score, 98);
});

test("verifyPhase rejects when violations are flagged", async () => {
  const mockLLM = async () =>
    JSON.stringify({
      passed: false,
      score: 40,
      violations: ["Missing baking temperature", "Used all-purpose flour"],
      remediationPrompt: "Replace flour with almond flour and specify baking temperature.",
    });

  const res = await verifyPhase(
    {
      taskType: "recipe",
      phase: "semantic_acceptance",
      prompt: "Create gluten-free banana bread",
      constraints: ["No wheat flour", "Include baking temperature"],
      output: "Mix flour, banana, eggs and bake until golden.",
    },
    mockLLM
  );

  assert.equal(res.passed, false);
  assert.equal(res.violations.length, 2);
  assert.match(res.remediationPrompt!, /Replace flour/);
});

test("verifyPhase fails safely on malformed LLM output", async () => {
  const mockLLM = async () => "Not valid json at all";

  const res = await verifyPhase(
    {
      taskType: "code",
      phase: "incremental_milestone",
      prompt: "Refactor database client",
      output: "const db = ...",
    },
    mockLLM
  );

  assert.equal(res.passed, false);
  assert.equal(res.violations[0], "Verifier output was unparseable or malformed JSON");
});

test("executeWithPhaseVerification loops until passed", async () => {
  let attempts = 0;
  const mockLLM = async () => {
    if (attempts === 1) {
      return JSON.stringify({ passed: false, score: 50, violations: ["Syntax error"], remediationPrompt: "Fix syntax" });
    }
    return JSON.stringify({ passed: true, score: 100, violations: [] });
  };

  const outcome = await executeWithPhaseVerification({
    taskType: "code",
    prompt: "Write factorial in TS",
    callLLM: mockLLM,
    generate: async (remedy) => {
      attempts++;
      return { output: attempts === 1 ? "broken code" : "function fact(n: number) { ... }" };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(outcome.audit.passed, true);
});

// ---- verifyPhase: prompt construction ----

test("verifyPhase sends the task, constraints and output to the verifier", async () => {
  let systemPrompt = "";
  let userPrompt = "";
  const mockLLM = async (system: string, user: string) => {
    systemPrompt = system;
    userPrompt = user;
    return JSON.stringify({ passed: true, score: 100, violations: [] });
  };

  await verifyPhase(
    {
      taskType: "code",
      phase: "semantic_acceptance",
      prompt: "Refactor the parser",
      constraints: ["Keep the public API", "No new dependencies"],
      output: "function parse() {}",
    },
    mockLLM
  );

  assert.match(systemPrompt, /Swarm Verification Harness Auditor/);
  assert.match(systemPrompt, /Phase 3/);
  assert.match(userPrompt, /Refactor the parser/);
  assert.match(userPrompt, /1\. Keep the public API/);
  assert.match(userPrompt, /2\. No new dependencies/);
  assert.match(userPrompt, /function parse\(\)/);
  assert.match(userPrompt, /semantic_acceptance/);
});

test("verifyPhase uses the phase guidance of the audited phase", async () => {
  const phases = [
    ["preflight_contract", /Phase 1/],
    ["incremental_milestone", /Phase 2/],
    ["semantic_acceptance", /Phase 3/],
  ] as const;

  for (const [phase, expected] of phases) {
    let systemPrompt = "";
    await verifyPhase(
      { taskType: "general", phase, prompt: "p", output: "o" },
      async (system) => {
        systemPrompt = system;
        return JSON.stringify({ passed: true, score: 100, violations: [] });
      }
    );
    assert.match(systemPrompt, expected);
  }
});

test("verifyPhase says 'None specified' when there are no constraints", async () => {
  let userPrompt = "";
  await verifyPhase(
    { taskType: "general", phase: "preflight_contract", prompt: "p", output: "o" },
    async (_system, user) => {
      userPrompt = user;
      return JSON.stringify({ passed: true, score: 100, violations: [] });
    }
  );
  assert.match(userPrompt, /CONSTRAINTS:\nNone specified/);
});

// ---- verifyPhase: parsing edge cases ----

test("verifyPhase strips markdown code fences around the JSON", async () => {
  const mockLLM = async () =>
    "```json\n" +
    JSON.stringify({ passed: true, score: 91, violations: [], remediationPrompt: "" }) +
    "\n```";

  const res = await verifyPhase(
    { taskType: "analysis", phase: "semantic_acceptance", prompt: "p", output: "o" },
    mockLLM
  );

  assert.equal(res.passed, true);
  assert.equal(res.score, 91);
});

test("verifyPhase fails a 'passed' verdict that still lists violations", async () => {
  const mockLLM = async () =>
    JSON.stringify({ passed: true, score: 70, violations: ["Still missing a step"] });

  const res = await verifyPhase(
    { taskType: "analysis", phase: "semantic_acceptance", prompt: "p", output: "o" },
    mockLLM
  );

  assert.equal(res.passed, false);
  assert.deepEqual(res.violations, ["Still missing a step"]);
});

test("verifyPhase defaults the score when the verifier omits it", async () => {
  const passing = await verifyPhase(
    { taskType: "general", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => JSON.stringify({ passed: true, violations: [] })
  );
  assert.equal(passing.score, 100);

  const failing = await verifyPhase(
    { taskType: "general", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => JSON.stringify({ passed: false, violations: ["nope"] })
  );
  assert.equal(failing.score, 0);
});

test("verifyPhase falls back to a generic remediation prompt", async () => {
  const res = await verifyPhase(
    { taskType: "general", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => JSON.stringify({ passed: false, score: 10, violations: ["broken"] })
  );

  assert.equal(res.passed, false);
  assert.equal(res.remediationPrompt, "Address stated violations.");
});

test("verifyPhase keeps only string violations and string remediation prompts", async () => {
  const res = await verifyPhase(
    { taskType: "general", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => JSON.stringify({ passed: false, score: 10, violations: ["ok", 42, null], remediationPrompt: 7 })
  );

  assert.deepEqual(res.violations, ["ok"]);
  assert.equal(typeof res.remediationPrompt, "string");
  assert.equal(res.remediationPrompt, "Address stated violations.");
});

test("verifyPhase ignores a non-array violations field", async () => {
  const res = await verifyPhase(
    { taskType: "general", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => JSON.stringify({ passed: true, score: 88, violations: "not an array" })
  );

  assert.deepEqual(res.violations, []);
  assert.equal(res.passed, true);
  assert.equal(res.score, 88);
});

test("verifyPhase reports metadata about the audited phase", async () => {
  const before = Date.now();
  const res = await verifyPhase(
    { taskType: "creative", phase: "incremental_milestone", prompt: "p", output: "o" },
    async () => JSON.stringify({ passed: true, score: 100, violations: [] })
  );
  const after = Date.now();

  assert.equal(res.metadata?.phase, "incremental_milestone");
  assert.equal(res.metadata?.taskType, "creative");
  assert.ok(typeof res.metadata?.timestamp === "number");
  assert.ok(res.metadata!.timestamp >= before && res.metadata!.timestamp <= after);
});

// ---- verifyPhase: error paths ----

test("verifyPhase fails safely when the verifier throws", async () => {
  const res = await verifyPhase(
    { taskType: "code", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => {
      throw new Error("provider exploded");
    }
  );

  assert.equal(res.passed, false);
  assert.equal(res.score, 0);
  assert.deepEqual(res.violations, ["Verifier output was unparseable or malformed JSON"]);
  assert.equal(res.remediationPrompt, "Re-run verification with strictly formatted JSON response.");
  assert.equal(res.metadata?.phase, "semantic_acceptance");
});

test("verifyPhase fails safely when the verifier returns a non-string", async () => {
  const res = await verifyPhase(
    { taskType: "code", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => undefined as unknown as string
  );

  assert.equal(res.passed, false);
  assert.deepEqual(res.violations, ["Verifier output was unparseable or malformed JSON"]);
});

test("verifyPhase fails safely when the verifier returns JSON that is not an object", async () => {
  const res = await verifyPhase(
    { taskType: "code", phase: "semantic_acceptance", prompt: "p", output: "o" },
    async () => "42"
  );

  assert.equal(res.passed, false);
  assert.equal(res.score, 0);
});

// ---- executeWithPhaseVerification ----

test("executeWithPhaseVerification passes the previous violations to the generator", async () => {
  const remedies: (string | undefined)[] = [];
  let call = 0;
  const mockLLM = async () => {
    call++;
    return call === 1
      ? JSON.stringify({ passed: false, score: 40, violations: ["Missing import"], remediationPrompt: "Add it" })
      : JSON.stringify({ passed: true, score: 100, violations: [] });
  };

  const outcome = await executeWithPhaseVerification({
    taskType: "code",
    prompt: "p",
    callLLM: mockLLM,
    generate: async (remedy) => {
      remedies.push(remedy);
      return { output: `attempt ${remedies.length}` };
    },
  });

  assert.equal(remedies.length, 2);
  assert.equal(remedies[0], undefined);
  assert.match(remedies[1] ?? "", /Missing import/);
  assert.match(remedies[1] ?? "", /Add it/);
  assert.equal(outcome.result.output, "attempt 2");
  assert.equal(outcome.audit.passed, true);
});

test("executeWithPhaseVerification throws after the remediation budget is spent", async () => {
  let generations = 0;
  let audits = 0;
  const mockLLM = async () => {
    audits++;
    return JSON.stringify({ passed: false, score: 20, violations: [`violation ${audits}`] });
  };

  await assert.rejects(
    executeWithPhaseVerification({
      taskType: "code",
      prompt: "p",
      maxRemediations: 2,
      callLLM: mockLLM,
      generate: async () => {
        generations++;
        return { output: "bad" };
      },
    }),
    /Task failed verification after 2 attempts: violation 2/
  );

  assert.equal(generations, 2);
  assert.equal(audits, 2);
});

test("executeWithPhaseVerification stops at the first passing attempt", async () => {
  let generations = 0;
  const outcome = await executeWithPhaseVerification({
    taskType: "code",
    prompt: "p",
    callLLM: async () => JSON.stringify({ passed: true, score: 100, violations: [] }),
    generate: async () => {
      generations++;
      return { output: "good" };
    },
  });

  assert.equal(generations, 1);
  assert.equal(outcome.result.output, "good");
  assert.equal(outcome.audit.score, 100);
});

test("executeWithPhaseVerification audits the semantic acceptance phase", async () => {
  let systemPrompt = "";
  await executeWithPhaseVerification({
    taskType: "recipe",
    prompt: "p",
    callLLM: async (system) => {
      systemPrompt = system;
      return JSON.stringify({ passed: true, score: 100, violations: [] });
    },
    generate: async () => ({ output: "o" }),
  });

  assert.match(systemPrompt, /Phase 3: Semantic & Acceptance Verification/);
});
