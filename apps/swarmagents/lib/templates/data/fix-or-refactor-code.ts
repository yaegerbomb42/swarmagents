import type { TaskTemplate } from "../types";

/** Category: fix or refactor code. */
export const FIX_OR_REFACTOR_CODE: TaskTemplate[] = [
  {
    id: "fix-failing-test",
    category: "fix-or-refactor-code",
    title: "Fix a failing test",
    pitch: "One red test becomes green, and you can tell whether the test or the code was wrong.",
    prompt:
      "In {{directory}} the test {{test_name}} fails. Find out why and fix it.\n\n" +
      "Do this in order:\n" +
      "1. Run the test and capture the exact failure output.\n" +
      "2. Read the code under test and decide whether the test or the implementation is wrong. Say which, and why.\n" +
      "3. Fix it — change the test only if the test encoded a wrong expectation, and say so in your report.\n" +
      "4. Run the full test suite, not just that one test.\n\n" +
      "The error I am seeing is: {{error_message}}\n\n" +
      "Do not weaken the assertion to make it pass, and do not delete the test.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "test_name", label: "Failing test", type: "text", placeholder: "checkout > applies discount", default: "checkout > applies discount" },
      { name: "error_message", label: "Error output", type: "textarea", placeholder: "paste the failure output", default: "expected 90 to equal 100" },
    ],
    role: "debugger",
    estimatedMinutes: 15,
    tools: ["bash", "read_file", "edit_file", "search"],
    mcp: [],
    example:
      "The test was wrong: it expected a 10% discount on the order total, but discounts apply to line items only.\n" +
      "Fix: the implementation was correct — changed the expectation to 90 and added the missing case for a discount that exceeds the line total.\n" +
      "Suite: 34 passing, 0 failing (npm test).",
  },
  {
    id: "fix-stack-trace",
    category: "fix-or-refactor-code",
    title: "Fix a crash from a stack trace",
    pitch: "You get a stack trace, you find the real cause and you fix it without papering over it.",
    prompt:
      "Something crashes in the project at {{directory}}. Here is the stack trace:\n\n{{stack_trace}}\n\n" +
      "Find the root cause and fix it.\n" +
      "- Reproduce the crash first and confirm you can trigger it.\n" +
      "- The error message is a symptom; find the line that actually causes it.\n" +
      "- Fix the cause, not the symptom: no try/catch that swallows the error, no `any` casts to silence the type checker.\n" +
      "- Add a test that fails before your fix and passes after it.\n" +
      "- Run the whole suite afterwards.\n\n" +
      "Report the root cause in one sentence, then the change, then the test output.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "stack_trace", label: "Stack trace", type: "textarea", placeholder: "paste the stack trace", default: "TypeError: Cannot read properties of undefined (reading 'id')\n    at createOrder (/workspace/src/orders.ts:88:20)\n    at POST /workspace/src/routes/orders.ts:31:7" },
    ],
    role: "debugger",
    estimatedMinutes: 20,
    tools: ["bash", "read_file", "search", "edit_file"],
    mcp: [],
    example:
      "Root cause: createOrder read customerId from req.body.customer, but the route passes it as customerId, so it was undefined and customer.id threw.\n" +
      "Change: orders.ts:88 now reads customerId, and the route passes customerId consistently.\n" +
      "Added test: 'createOrder rejects a missing customer' — failed before, passes now.\n" +
      "Suite: 41 passing, 0 failing.",
  },
  {
    id: "refactor-for-testability",
    category: "fix-or-refactor-code",
    title: "Refactor code so it can be tested",
    pitch: "The logic is pulled out of the tangle into pure functions that a test can drive directly.",
    prompt:
      "Refactor {{module}} in {{directory}} so its logic is testable, without changing behaviour.\n\n" +
      "Current situation: {{problem_description}}\n\n" +
      "Requirements:\n" +
      "- Separate the decision-making logic from the I/O. The pure part should take plain arguments and return plain values.\n" +
      "- Inject the side effects (clock, network, filesystem) instead of importing them directly.\n" +
      "- Keep the public interface of the module unchanged unless you explain why it must change.\n" +
      "- Write unit tests for the extracted logic that cover the edge cases: {{edge_cases}}.\n" +
      "- Prove you did not change behaviour: run the existing suite before and after, and report both results.\n\n" +
      "Keep the diff focused. No drive-by renames or formatting churn.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "module", label: "Module or file to refactor", type: "text", default: "src/checkout.ts" },
      { name: "problem_description", label: "What makes it hard to test today", type: "textarea", default: "The function does pricing, tax and persistence in one body, and reaches for Date.now() and the db module directly." },
      { name: "edge_cases", label: "Edge cases to cover", type: "text", default: "empty cart, expired coupon, zero-quantity line" },
    ],
    role: "implementer",
    estimatedMinutes: 30,
    tools: ["read_file", "edit_file", "bash", "write_file"],
    mcp: [],
    example:
      "src/checkout.ts: extracted computeTotals(lines, coupon, now) — pure, returns {subtotal, discount, tax, total}.\n" +
      "checkout() now takes {lines, coupon, now, repo} and only does I/O.\n" +
      "Tests added: empty cart, expired coupon (now injected, not Date.now()), zero-quantity line — 6 cases.\n" +
      "Before: 18 passing. After: 24 passing, same 18 unchanged.",
  },
  {
    id: "add-missing-tests",
    category: "fix-or-refactor-code",
    title: "Add the missing tests",
    pitch: "The gaps in coverage get filled with real cases, not tests that only restate the code.",
    prompt:
      "Add missing tests for {{module}} in {{directory}}.\n\n" +
      "Steps:\n" +
      "1. Run the existing suite and the coverage report to find what is untested.\n" +
      "2. For each uncovered branch, decide whether it deserves a test.\n" +
      "3. Write behaviour-level tests: assert on the result a caller sees, not on internal calls. No mocking of the function under test.\n" +
      "4. Target the branches that matter: {{focus_areas}}.\n" +
      "5. Report the coverage before and after.\n\n" +
      "Never write a test that only asserts a mock was called. If a branch is not worth testing, say why.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "module", label: "Module to cover", type: "text", default: "src/pricing.ts" },
      { name: "focus_areas", label: "Branches that matter", type: "text", default: "currency rounding, tier boundaries, expired promotions" },
    ],
    role: "test-writer",
    estimatedMinutes: 25,
    tools: ["read_file", "bash", "write_file", "edit_file"],
    mcp: [],
    example:
      "src/pricing.ts — statement coverage 71% -> 96%, branch 58% -> 91%.\n" +
      "Added 14 tests: rounding half-up at 0.5 cents, tier boundary exactly at 1000 units, expired promo ignores the discount, zero-quantity line is free.\n" +
      "No mock-only assertions: every test asserts the computed price.",
  },
  {
    id: "performance-profile-and-fix",
    category: "fix-or-refactor-code",
    title: "Profile and fix a slow function",
    pitch: "A measured before-and-after, not a guess. The hot path gets faster and stays correct.",
    prompt:
      "The function {{function_name}} in {{directory}} is too slow. It currently takes {{current_time}} on {{input_description}}.\n\n" +
      "Do this:\n" +
      "1. Write a benchmark that reproduces that timing, so you can measure the change.\n" +
      "2. Profile it and identify the actual hot spot. Quote the profile output.\n" +
      "3. Optimise that hot spot — an index, an algorithm change, a cache, fewer round trips. Do not micro-optimise anything the profile did not flag.\n" +
      "4. Re-run the benchmark and report before and after.\n" +
      "5. Run the full test suite to prove the behaviour is unchanged.\n\n" +
      "If the speed-up is under {{target_speedup}}, say so honestly and explain what would be needed.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "function_name", label: "Slow function", type: "text", default: "searchOrders" },
      { name: "current_time", label: "Current timing", type: "text", default: "4.2s" },
      { name: "input_description", label: "Input size", type: "text", default: "50,000 orders" },
      { name: "target_speedup", label: "Target speed-up", type: "text", default: "2x" },
    ],
    role: "implementer",
    estimatedMinutes: 30,
    tools: ["bash", "read_file", "edit_file", "write_file"],
    mcp: [],
    example:
      "Hot spot (from the profile): searchOrders did a SELECT per order inside the loop — 50,000 round trips.\n" +
      "Fix: one JOIN query with the same filter, then the existing post-processing in memory.\n" +
      "Benchmark: 4.21s -> 0.19s (22x). Suite: 24 passing, unchanged.",
  },
  {
    id: "migrate-framework-version",
    category: "fix-or-refactor-code",
    title: "Upgrade a dependency safely",
    pitch: "A major version bump that keeps every test green, one step at a time.",
    prompt:
      "Upgrade {{package_name}} from {{from_version}} to {{to_version}} in {{directory}}.\n\n" +
      "Rules:\n" +
      "- Read the changelog for the versions in between and list the breaking changes that affect this codebase.\n" +
      "- Upgrade one major version at a time. Run the tests after each step and commit or note the state.\n" +
      "- Fix every usage of a removed or renamed API. Do not shim old behaviour back in with a compatibility layer unless the changelog says it is required.\n" +
      "- Keep the public behaviour of the app identical: the tests must pass without being edited to match the new behaviour.\n" +
      "- Note any deprecation warnings that remain.\n\n" +
      "Report the breaking changes you hit, what you changed for each, and the final test result.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "package_name", label: "Package", type: "text", default: "react-router" },
      { name: "from_version", label: "From version", type: "text", default: "5.3.0" },
      { name: "to_version", label: "To version", type: "text", default: "6.20.0" },
    ],
    role: "implementer",
    estimatedMinutes: 25,
    tools: ["bash", "read_file", "edit_file", "search"],
    mcp: [],
    example:
      "Breaking changes hit: useRoutes -> useRoutes still fine; <Route element> -> <Route Component>; loader functions moved to a route module.\n" +
      "Changed 7 call sites across 4 files. No test was edited.\n" +
      "Suite: 38 passing before, 38 passing after.",
  },
  {
    id: "fix-race-condition",
    category: "fix-or-refactor-code",
    title: "Fix a race condition",
    pitch: "Two things that race now interleave safely, and a test reproduces the collision.",
    prompt:
      "There is a race condition in {{directory}} between {{component_a}} and {{component_b}}. Sometimes {{observed_symptom}}.\n\n" +
      "Do this:\n" +
      "1. Find the shared state and the interleaving that causes it. Explain the sequence in two or three sentences.\n" +
      "2. Write a test that reproduces the race deterministically — use a controlled barrier, a fake clock, or a fake driver so the interleaving is repeatable. A flaky test is not acceptable.\n" +
      "3. Fix it with the smallest correct change: a lock, a transaction, an idempotency key, or making the ordering explicit. Match the pattern the rest of the codebase already uses.\n" +
      "4. Run the new test many times to prove it is stable, and run the full suite.\n\n" +
      "Do not add sleeps to hide the race.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "component_a", label: "First participant", type: "text", default: "the checkout handler" },
      { name: "component_b", label: "Second participant", type: "text", default: "the inventory decrement" },
      { name: "observed_symptom", label: "What goes wrong", type: "textarea", default: "stock goes negative when two customers buy the last item at the same time" },
    ],
    role: "debugger",
    estimatedMinutes: 30,
    tools: ["read_file", "bash", "edit_file", "search", "write_file"],
    mcp: [],
    example:
      "Race: checkout read the stock count, then decremented it in a second statement; two concurrent buyers both read 1 and both decremented.\n" +
      "Fix: the decrement is now a single conditional UPDATE ... WHERE stock > 0 and the handler checks the affected-row count.\n" +
      "Test: 'two concurrent buyers cannot oversell' — uses a barrier so both orders interleave at the same point. Ran 50 times, always green.\n" +
      "Suite: 31 passing.",
  },
  {
    id: "review-and-apply-feedback",
    category: "fix-or-refactor-code",
    title: "Apply review feedback properly",
    pitch: "Every comment is either addressed or argued against — with a reason, in the diff.",
    prompt:
      "Apply the code review feedback below to the changes in {{directory}}.\n\n" +
      "Feedback:\n{{feedback}}\n\n" +
      "Rules:\n" +
      "- For each comment, implement it, or explain in one sentence why you did not. Never silently ignore one.\n" +
      "- Do not change behaviour the reviewer did not ask about. Keep the diff scoped to the feedback.\n" +
      "- If a comment conflicts with another comment, say so and pick the one that keeps the code correct.\n" +
      "- Run the tests after the changes and report the result.\n" +
      "- Write a short summary mapping each comment to the change that addressed it.\n\n" +
      "The reviewer will read the diff, not the summary, so keep the diff readable.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "feedback", label: "Review feedback", type: "textarea", default: "1. extract the duplicated parse logic\n2. the error message should name the field that failed\n3. this test asserts on a mock — please test the behaviour" },
    ],
    role: "code-reviewer",
    estimatedMinutes: 20,
    tools: ["read_file", "edit_file", "bash"],
    mcp: [],
    example:
      "1. Duplicated parse logic -> extracted parseConfig(), used by both call sites.\n" +
      "2. Error message -> now names the field: 'config.port: expected a number, got \"abc\"'.\n" +
      "3. Mock-only test -> replaced with a behaviour test that feeds a real payload and asserts the parsed result.\n" +
      "Suite: 27 passing.",
  },
];
