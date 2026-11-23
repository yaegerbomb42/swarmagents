import type { TaskTemplate } from "../types";

/** Category: research and reports. */
export const RESEARCH_AND_REPORTS: TaskTemplate[] = [
  {
    id: "compare-libraries",
    category: "research-and-reports",
    title: "Compare libraries before choosing one",
    pitch: "A decision table with evidence from real sources, and a clear recommendation.",
    prompt:
      "Compare the libraries {{library_a}} and {{library_b}} for this use case: {{use_case}}.\n\n" +
      "Requirements:\n" +
      "- Use current sources: the official docs, the changelog and the release dates. Give the URL and the date you read it.\n" +
      "- Compare on: {{comparison_criteria}}.\n" +
      "- Note the last release date and the open-issue count for each.\n" +
      "- End with a recommendation for {{use_case}} and the one condition that would flip it.\n" +
      "- Mark anything you could not verify as 'unverified' instead of guessing.\n\n" +
      "Write the report to {{output_path}} as markdown.",
    fields: [
      { name: "library_a", label: "First library", type: "text", default: "zod" },
      { name: "library_b", label: "Second library", type: "text", default: "valibot" },
      { name: "use_case", label: "Use case", type: "text", default: "validating request bodies in a TypeScript API" },
      { name: "comparison_criteria", label: "Criteria to compare", type: "text", default: "bundle size, API ergonomics, error messages, TypeScript inference" },
      { name: "output_path", label: "Where to write the report", type: "text", default: "/workspace/research/library-comparison.md" },
    ],
    role: "researcher",
    estimatedMinutes: 20,
    tools: ["web_fetch", "web_search", "read_file", "write_file"],
    mcp: [],
    example:
      "# zod vs valibot for request-body validation\n\n" +
      "| | zod | valibot |\n|---|---|---|\n| bundle size | 13.4 kB | 1.2 kB |\n| inference | good | best |\n| error messages | verbose | terse |\n\n" +
      "zod 4.6.7 released 2026-11-04 (docs.z.dev); valibot 1.2.0 released 2026-09-22.\n" +
      "Recommendation: valibot for the API edge where bundle size matters; zod if shared schemas with the UI. Flip to zod if you need the plugin ecosystem.",
  },
  {
    id: "audit-a-dependency",
    category: "research-and-reports",
    title: "Audit one dependency for risk",
    pitch: "Who maintains it, what it can reach, and whether you should keep it.",
    prompt:
      "Audit the dependency {{package_name}} (currently version {{version}}) used in {{directory}}.\n\n" +
      "Report on:\n" +
      "- What it is, what it does and what the project actually uses it for. Quote the import sites.\n" +
      "- Maintenance: last release, commit activity, open issue and PR counts, number of maintainers.\n" +
      "- Supply-chain risk: how many transitive dependencies it pulls in, whether it runs install scripts, and whether it has network access at build time.\n" +
      "- Licence and any known advisories for this version.\n" +
      "- A verdict: keep, replace with {{alternative}}, or drop — with the reasoning in three sentences.\n\n" +
      "Cite a URL for every factual claim and say 'unverified' where you could not check. Write to {{output_path}}.",
    fields: [
      { name: "package_name", label: "Package", type: "text", default: "moment" },
      { name: "version", label: "Version in use", type: "text", default: "2.29.4" },
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "alternative", label: "Preferred alternative", type: "text", default: "date-fns or Temporal" },
      { name: "output_path", label: "Where to write the report", type: "text", default: "/workspace/research/dependency-audit.md" },
    ],
    role: "security-auditor",
    estimatedMinutes: 20,
    tools: ["bash", "web_fetch", "read_file", "write_file"],
    mcp: [],
    example:
      "# Audit: moment 2.29.4\n\n" +
      "Used at 6 import sites, all for date formatting (src/report.ts:12, src/schedule.ts:44, ...).\n" +
      "Maintenance: last release 2024-05-14; 2 maintainers; 412 open issues.\n" +
      "Supply chain: 1 direct dep (js-cookie); 14 transitive; no install scripts; no network at build time.\n" +
      "Licence MIT. No advisory for 2.29.4 (npm audit: clean).\n" +
      "Verdict: replace with date-fns — the project only formats, and Temporal is available in the runtime.",
  },
  {
    id: "explain-a-codebase",
    category: "research-and-reports",
    title: "Explain how a codebase works",
    pitch: "A map of the system: the entry points, the data flow and the parts that matter.",
    prompt:
      "Explain how the project at {{directory}} works, for a developer who has never seen it.\n\n" +
      "Cover:\n" +
      "- Entry points: how the process starts and what the first file does.\n" +
      "- The main data flow from request to response, with the {{focus_area}} part in the most detail.\n" +
      "- The state and the boundaries: what is in memory, what is on disk, what goes over the network.\n" +
      "- The {{number_of_modules}} modules that matter, one short paragraph each, with the file path.\n" +
      "- The three things a newcomer is most likely to get wrong.\n\n" +
      "Quote real file paths and line numbers. Do not guess — if something is unclear from the code, say so. Write to {{output_path}}.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "focus_area", label: "Part to explain in most detail", type: "text", default: "the authentication flow" },
      { name: "number_of_modules", label: "How many modules to describe", type: "text", default: "5" },
      { name: "output_path", label: "Where to write the explanation", type: "text", default: "/workspace/research/architecture.md" },
    ],
    role: "researcher",
    estimatedMinutes: 25,
    tools: ["read_file", "search", "bash", "write_file"],
    mcp: [],
    example:
      "# How the service works\n\n" +
      "Entry: src/server.ts:14 boots the HTTP server; src/app.ts:22 registers routes.\n" +
      "Request flow: middleware/auth.ts:9 verifies the session cookie, then routes/orders.ts:31 loads the order and calls domain/pricing.ts:18.\n" +
      "State: orders live in Postgres (repositories/order.ts), sessions in Redis, nothing else is durable.\n" +
      "Gotchas: (1) prices are cached per-process for 30s, so two instances disagree briefly; (2) the order total is recomputed on read, never stored.",
  },
  {
    id: "competitive-teardown",
    category: "research-and-reports",
    title: "Tear down a competitor product",
    pitch: "What a rival actually does, checked in their own live product, with evidence.",
    prompt:
      "Research the product {{competitor}} for the purpose of {{purpose}}.\n\n" +
      "Use the live product: browse the marketing site, the pricing page and the docs. If a page needs an account, say so instead of guessing.\n\n" +
      "Report:\n" +
      "- What the product does, in five sentences, in their own words.\n" +
      "- Pricing: the tiers, what is in each, and the limits that would push a customer to upgrade.\n" +
      "- The {{focus_area}} — what is strong, what is weak, and what is missing outright.\n" +
      "- Three things a customer would complain about.\n" +
      "- Two gaps we could use, with the reason each is a real gap rather than a missing feature.\n\n" +
      "Every claim gets the URL you saw it on. Write to {{output_path}}.",
    fields: [
      { name: "competitor", label: "Competitor", type: "text", default: "Linear" },
      { name: "purpose", label: "What the research is for", type: "text", default: "our product positioning page" },
      { name: "focus_area", label: "Area to focus on", type: "text", default: "the onboarding experience" },
      { name: "output_path", label: "Where to write the teardown", type: "text", default: "/workspace/research/competitor-teardown.md" },
    ],
    role: "researcher",
    estimatedMinutes: 30,
    tools: ["browser", "web_fetch", "web_search", "write_file"],
    mcp: [],
    example:
      "# Linear teardown — for our positioning page\n\n" +
      "Linear: issue tracking for product teams, keyboard-first, free for up to 10 collaborators (linear.app/pricing).\n" +
      "Onboarding (linear.app/start): three-step form, an empty board, and a sample issue; first value in ~2 minutes. Strongest part of the funnel.\n" +
      "Complaints visible in public reviews: search is slow on large boards; no offline mode.\n" +
      "Gaps we could use: no native form-builder (we have one), and no per-project guest access without a seat.",
  },
  {
    id: "read-the-git-history",
    category: "research-and-reports",
    title: "Find out why the code changed",
    pitch: "Blame, log and diff used together to explain how the code got to where it is.",
    prompt:
      "In the repository at {{directory}}, explain how the code around {{subject}} came to be the way it is.\n\n" +
      "Do this:\n" +
      "1. Use git log and git blame on the relevant files to find the commits that shaped them.\n" +
      "2. For each important commit, read the message and the diff. Look for the reason in the commit body, the linked issue, or the test that came with it.\n" +
      "3. Reconstruct the sequence: what was tried, what was reverted, and why the current shape won.\n" +
      "4. Flag anything that looks accidental — a workaround with no explanation, a duplicated fix in two places.\n\n" +
      "Cite commit SHAs. Write the explanation to {{output_path}}.",
    fields: [
      { name: "directory", label: "Repository directory", type: "text", default: "/workspace" },
      { name: "subject", label: "Code to explain", type: "text", default: "the retry logic in the fetch client" },
      { name: "output_path", label: "Where to write the explanation", type: "text", default: "/workspace/research/history.md" },
    ],
    role: "researcher",
    estimatedMinutes: 20,
    tools: ["bash", "read_file", "search", "write_file"],
    mcp: [],
    example:
      "# How the fetch retry logic got here\n\n" +
      "a1b2c3d (2026-03-02) 'retry on 5xx' — added a single retry with a fixed 1s delay.\n" +
      "e4f5a6b (2026-05-19) 'exponential backoff' — replaced it after p99 latency spiked.\n" +
      "7g8h9i0 (2026-08-04) 'only retry idempotent methods' — POST retries were duplicating orders.\n" +
      "Accidental: the 5xx check also matches 501, which is not retryable (see src/http.ts:88 — flagged, not fixed).",
  },
  {
    id: "research-an-api",
    category: "research-and-reports",
    title: "Learn a third-party API",
    pitch: "Endpoints, auth, limits and one working call, read from the real documentation.",
    prompt:
      "Learn the {{api_name}} API so we can integrate with it.\n\n" +
      "Report:\n" +
      "- Auth: the exact header or query parameter, and how the key is rotated.\n" +
      "- The endpoints we need for {{use_case}}, with the method, path, required parameters and one real response body.\n" +
      "- Rate limits: the number, the window, the headers that report them, and the back-off the docs require.\n" +
      "- Pagination: the parameter and the shape of the cursor.\n" +
      "- The error format: the status codes, the body shape, and which ones are retryable.\n" +
      "- One working example: a real request you made, with the command and the trimmed response.\n\n" +
      "Do not invent endpoints. If the docs are behind a login, say so. Write to {{output_path}}.",
    fields: [
      { name: "api_name", label: "API", type: "text", default: "Stripe" },
      { name: "use_case", label: "What we need from it", type: "text", default: "creating a customer and a subscription" },
      { name: "output_path", label: "Where to write the notes", type: "text", default: "/workspace/research/api-notes.md" },
    ],
    role: "backend-engineer",
    estimatedMinutes: 25,
    tools: ["web_fetch", "web_search", "bash", "write_file"],
    mcp: [],
    example:
      "# Stripe — customers + subscriptions\n\n" +
      "Auth: `Authorization: Bearer sk_...` (docs.stripe.com/keys).\n" +
      "POST /v1/customers {email, name} -> {id: cus_1A2b, ...}\n" +
      "POST /v1/subscriptions {customer, items[]} -> {id: sub_1C3d, status: active}\n" +
      "Rate limit: 100 req/s live; headers x-ratelimit-remaining; back off 0.5s and retry once on 429.\n" +
      "Pagination: limit + starting_after cursor, has_more flag.\n" +
      "Errors: {error: {type, message, code}}; 429 retryable, 400 not.\n" +
      "Example: curl -s https://api.stripe.com/v1/customers -d email=... -> {\"id\":\"cus_1A2b\", ...}",
  },
  {
    id: "interview-the-codebase",
    category: "research-and-reports",
    title: "Interview the codebase",
    pitch: "Ask the code questions a new hire would ask and answer them with quotes.",
    prompt:
      "You are onboarding onto the project at {{directory}}. Answer these questions by reading the code, not by guessing:\n\n" +
      "{{questions}}\n\n" +
      "Rules:\n" +
      "- Each answer cites the file and line that proves it.\n" +
      "- Where the answer is 'this is decided at runtime', say that and point to where the decision is made.\n" +
      "- Where the code does not answer the question, say 'the code does not say' — do not fill the gap with a plausible guess.\n" +
      "- End with the three things you would still ask a human.\n\n" +
      "Write the answers to {{output_path}}.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "questions", label: "Questions to answer", type: "textarea", default: "Where does configuration come from?\nWhich module owns the database schema?\nHow does a failed background job get retried?" },
      { name: "output_path", label: "Where to write the answers", type: "text", default: "/workspace/research/interview.md" },
    ],
    role: "researcher",
    estimatedMinutes: 25,
    tools: ["read_file", "search", "bash", "write_file"],
    mcp: [],
    example:
      "# Onboarding answers\n\n" +
      "Q: Where does configuration come from?\nA: Environment variables, read once in src/config.ts:11 with defaults; there is no config file.\n\n" +
      "Q: Which module owns the database schema?\nA: db/migrations/001_init.sql, applied by src/db/migrate.ts:24 at start-up. No ORM.\n\n" +
      "Q: How does a failed background job get retried?\nA: The code does not say — src/jobs/worker.ts catches the error and logs it (worker.ts:58); there is no retry path I could find.\n\n" +
      "Still to ask a human: where the retry policy for jobs is decided; who owns the schema migrations.",
  },
];
