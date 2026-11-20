import type { TaskTemplate } from "../types";

/** Category: content and docs. */
export const CONTENT_AND_DOCS: TaskTemplate[] = [
  {
    id: "write-a-readme",
    category: "content-and-docs",
    title: "Write a README that works",
    pitch: "What it is, how to run it, and a copy-pasteable first command — in the order people need them.",
    prompt:
      "Write a README for the project at {{directory}} and save it to {{output_path}}.\n\n" +
      "Audience: {{audience}}.\n\n" +
      "It must contain, in this order:\n" +
      "1. One sentence on what this is, and one screenshot or diagram if you can produce one.\n" +
      "2. The requirements — exact versions of the runtime and any system packages.\n" +
      "3. A copy-pasteable quick start that actually works. Run every command you put in it and fix the ones that fail.\n" +
      "4. How to run the tests.\n" +
      "5. Configuration: every environment variable in a table with its name, whether it is required, and a safe example value.\n" +
      "6. Common problems and their fixes.\n\n" +
      "No placeholder sections. If the project genuinely has no configuration, write 'This project has no configuration.' rather than inventing a table.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "output_path", label: "Where to write the README", type: "text", default: "/workspace/README.md" },
      { name: "audience", label: "Who reads it", type: "text", default: "a developer who has never seen the project" },
    ],
    role: "technical-writer",
    estimatedMinutes: 20,
    tools: ["read_file", "bash", "write_file"],
    mcp: [],
    example:
      "# swarmagents\n\n" +
      "One chat bar that drives an autonomous agent running on its own Linux computer.\n\n" +
      "## Requirements\n" +
      "Node 22+, Docker 27+ (for the VM image), 4 GB RAM free.\n\n" +
      "## Quick start\n" +
      "```bash\n" +
      "npm ci\n" +
      "docker compose up -d\n" +
      "npm run dev\n" +
      "```\n" +
      "Then open http://127.0.0.1:3777.\n\n" +
      "## Tests\n" +
      "```bash\n" +
      "npm test\n" +
      "```\n\n" +
      "## Configuration\n" +
      "| Variable | Required | Example |\n|---|---|---|\n| SWARM_SERVER_MODE | no | 1 |\n| SWARM_SESSION_SECRET | in production | openssl rand -hex 32 |\n| SWARM_ALLOWED_HOSTS | in production | app.example.com |",
  },
  {
    id: "write-api-docs",
    category: "content-and-docs",
    title: "Document an API",
    pitch: "Every endpoint with its request, response, errors and a curl call that works.",
    prompt:
      "Write API documentation for the routes in {{directory}} and save it to {{output_path}}.\n\n" +
      "For every route:\n" +
      "- Method and path, with what it does in one line.\n" +
      "- The path, query and body parameters, each with its type, whether it is required, and an example value.\n" +
      "- The authentication it needs.\n" +
      "- A real response with a status code, taken from the code or from a real call — not an invented body.\n" +
      "- Every error it can return, with the status code and when it happens.\n" +
      "- A curl example with a real URL and a real body.\n\n" +
      "Read the routes from the code. If a route has no tests and no obvious handler, say so rather than guessing its behaviour. Group the routes by resource.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace" },
      { name: "output_path", label: "Where to write the docs", type: "text", default: "/workspace/docs/API.md" },
    ],
    role: "technical-writer",
    estimatedMinutes: 30,
    tools: ["read_file", "search", "bash", "write_file"],
    mcp: [],
    example:
      "# API\n\n" +
      "## Orders\n\n" +
      "### GET /api/orders\n" +
      "Lists orders for the caller.\n" +
      "| Param | Type | Required | Example |\n|---|---|---|---|\n| limit | integer | no | 20 |\n| sessionId | string | no | s_123 |\n\n" +
      "Auth: session cookie or `Authorization: Bearer $SWARM_HARNESS_TOKEN`.\n" +
      "200: `{\"runs\":[{\"runId\":\"run_1\",\"status\":\"finished\",\"tokensIn\":1200}]}`\n" +
      "401: `{\"error\":\"Sign in required.\"}`\n" +
      "```bash\n" +
      "curl -H \"Authorization: Bearer $TOKEN\" 'http://127.0.0.1:3777/api/orders?limit=20'\n" +
      "```",
  },
  {
    id: "write-a-blog-post",
    category: "content-and-docs",
    title: "Write a blog post",
    pitch: "A real argument with a real point of view, not a list of bullet points in a vest.",
    prompt:
      "Write a blog post titled \"{{title}}\" about {{topic}} and save it to {{output_path}}.\n\n" +
      "Requirements:\n" +
      "- Audience: {{audience}}. Length: {{length}}.\n" +
      "- One argument, stated in the first paragraph, that the post defends.\n" +
      "- Concrete examples, not abstractions. Name the tools, the numbers, the failure modes.\n" +
      "- At least one place where you say what the reader should not do, and why.\n" +
      "- A short ending that says what the reader should do next — one action, not five.\n" +
      "- Markdown with headings, and code blocks for any code.\n\n" +
      "Do not open with 'In today's fast-paced world' or close with 'the possibilities are endless'.",
    fields: [
      { name: "title", label: "Title", type: "text", default: "Your agent has a shell. That is the whole product." },
      { name: "topic", label: "Topic", type: "text", default: "why giving an agent a real machine changes what it can do" },
      { name: "audience", label: "Audience", type: "text", default: "engineers who have used coding assistants" },
      { name: "length", label: "Length", type: "select", options: ["400 words", "800 words", "1,500 words"], default: "800 words" },
      { name: "output_path", label: "Where to write the post", type: "text", default: "/workspace/blog/post.md" },
    ],
    role: "technical-writer",
    estimatedMinutes: 25,
    tools: ["write_file", "read_file", "web_search"],
    mcp: [],
    example:
      "# Your agent has a shell. That is the whole product.\n\n" +
      "Most coding assistants edit text. The one I want gives an agent a machine, and the difference shows up in the first five minutes: it installs the package, runs the test, reads the failure and fixes it — without me pasting anything back.\n\n" +
      "What that buys you is not speed. It is *verification*. An agent that cannot run the test will happily hand you code that does not compile.\n\n" +
      "The part people get wrong: do not give it root, and do not give it your production credentials. A shell with your SSH keys is an incident waiting to happen.\n\n" +
      "So: run one agent per repository, in a container, with the credentials scoped to that repository. That is the whole setup. Everything else is optional.",
  },
  {
    id: "write-release-notes",
    category: "content-and-docs",
    title: "Write release notes",
    pitch: "What changed, what breaks, and what you have to do — grouped by the kind of change.",
    prompt:
      "Write release notes for the changes between {{from_ref}} and {{to_ref}} in {{directory}}, and save them to {{output_path}}.\n\n" +
      "Use the git history: the commits, the diff, and any linked issue in the commit message.\n\n" +
      "Group the changes under:\n" +
      "- **Breaking** — anything a user could notice. Say what they must change.\n" +
      "- **Added** — new things, each with a one-line description of what it does for the user.\n" +
      "- **Fixed** — the bug in one line, and what the symptom was.\n" +
      "- **Internal** — refactors and chores, one line each, or omit the section if there is nothing worth saying.\n\n" +
      "Link each entry to its commit. Write for someone deciding whether to upgrade, not for someone reading the diff.",
    fields: [
      { name: "directory", label: "Repository directory", type: "text", default: "/workspace" },
      { name: "from_ref", label: "From ref", type: "text", default: "v2.0.0" },
      { name: "to_ref", label: "To ref", type: "text", default: "v2.1.0" },
      { name: "output_path", label: "Where to write the notes", type: "text", default: "/workspace/CHANGELOG.md" },
    ],
    role: "technical-writer",
    estimatedMinutes: 15,
    tools: ["bash", "read_file", "write_file"],
    mcp: [],
    example:
      "# v2.1.0\n\n" +
      "## Breaking\n" +
      "- The `/api/runtime/tasks` endpoint now requires a session cookie; bearer-only clients must set the `Authorization` header. (a1b2c3d)\n\n" +
      "## Added\n" +
      "- Run reports: every run ends with a summary, screenshots and artifacts. (e4f5a6b)\n" +
      "- The status page reports the git SHA and build time. (7g8h9i0)\n\n" +
      "## Fixed\n" +
      "- Runs died with exit 137 when the VM was busy; the run now survives and reports the real error. (1j2k3l)\n" +
      "- The terminal no longer showed raw run.queued JSON. (4m5n6o)",
  },
  {
    id: "write-user-docs",
    category: "content-and-docs",
    title: "Write user documentation",
    pitch: "Task-shaped documentation: what the user is trying to do, and the steps that do it.",
    prompt:
      "Write the documentation page for {{feature}} and save it to {{output_path}}.\n\n" +
      "Audience: {{audience}}. They are trying to accomplish {{goal}}.\n\n" +
      "Structure:\n" +
      "- A title that names the task, not the feature: 'Connect your own API key', not 'Providers'.\n" +
      "- One paragraph on why someone would want this and when to skip it.\n" +
      "- Numbered steps. Each step says exactly what to click and what you should see afterwards, so the user knows it worked.\n" +
      "- A screenshot after the first step that changes something, with a caption.\n" +
      "- The failure cases: what happens if the key is wrong, if the provider is down, if the quota is hit — and what to do about each.\n" +
      "- A 'Related' section with links to the pages that come next.\n\n" +
      "Use the second person. No marketing language.",
    fields: [
      { name: "feature", label: "Feature to document", type: "text", default: "connecting a provider API key" },
      { name: "output_path", label: "Where to write the page", type: "text", default: "/workspace/docs/connect-a-provider.md" },
      { name: "audience", label: "Audience", type: "text", default: "a first-time user" },
      { name: "goal", label: "What the user is trying to do", type: "text", default: "use their own Anthropic key instead of the shared one" },
    ],
    role: "technical-writer",
    estimatedMinutes: 20,
    tools: ["read_file", "browser", "write_file"],
    mcp: [],
    example:
      "# Connect your own API key\n\n" +
      "Bring your own Anthropic key if you want the agent to run on your own account — you pay Anthropic directly, and your key never reaches the browser.\n\n" +
      "## Steps\n" +
      "1. Open **Settings** from the gear icon in the top right. You should see the Providers tab.\n" +
      "2. Click **Add key** under Anthropic and paste the key. The field masks what you typed after you paste.\n" +
      "3. Click **Test connection**. A green 'Reachable · 180 ms' chip means the key works.\n" +
      "4. Close Settings. The provider count in the top bar now shows 1.\n\n" +
      "## If something goes wrong\n" +
      "- **401 from Anthropic** — the key is wrong or has whitespace. Delete it and paste it again.\n" +
      "- **429** — you hit the rate limit. The key is marked as cooling down for 60 seconds and the router tries your other providers.\n\n" +
      "## Related\n" +
      "- [How routing picks a provider](/docs/routing)\n" +
      "- [Removing a key](/docs/remove-a-key)",
  },
  {
    id: "write-a-tutorial",
    category: "content-and-docs",
    title: "Write a tutorial",
    pitch: "One thing built from nothing to working, with the reader doing it at every step.",
    prompt:
      "Write a tutorial that walks the reader through {{goal}} using {{subject}}.\n\n" +
      "Save it to {{output_path}}.\n\n" +
      "Rules:\n" +
      "- The reader types every command. Do not skip the boring middle.\n" +
      "- Each step ends with what the reader should see, so they can tell whether it worked before moving on.\n" +
      "- Show the expected output, including the error they might get if they miss something.\n" +
      "- Keep one idea per step. If a step needs a paragraph of explanation, it is two steps.\n" +
      "- End with what to do next, and one thing that goes wrong often.\n\n" +
      "Length: {{length}}. Read it as if you were the reader following it on a machine that is not yours.",
    fields: [
      { name: "goal", label: "What the reader builds", type: "text", default: "a deploy script that rolls back on failure" },
      { name: "subject", label: "Subject of the tutorial", type: "text", default: "bash and systemd" },
      { name: "output_path", label: "Where to write the tutorial", type: "text", default: "/workspace/docs/tutorial-deploy.md" },
      { name: "length", label: "Length", type: "select", options: ["short", "medium", "long"], default: "medium" },
    ],
    role: "technical-writer",
    estimatedMinutes: 30,
    tools: ["bash", "write_file", "read_file"],
    mcp: [],
    example:
      "# Build a deploy script that rolls back on failure\n\n" +
      "## Step 1 — make a health endpoint\n" +
      "If your service has no health endpoint, add one first. Create `health.js`:\n\n" +
      "```js\n" +
      "app.get('/health', (_req, res) => res.json({ status: 'ok' }));\n" +
      "```\n\n" +
      "Start the app and check it:\n\n" +
      "```bash\n" +
      "node server.js &\n" +
      "curl -s localhost:3000/health\n" +
      "```\n\n" +
      "You should see `{\"status\":\"ok\"}`. If you see `Cannot GET /health`, the route is registered after the app is created — move it up.\n\n" +
      "## Step 2 — snapshot the current release\n" +
      "...",
  },
  {
    id: "proofread-a-document",
    category: "content-and-docs",
    title: "Proofread a document",
    pitch: "Typos, broken sentences and wrong names fixed — with the changes listed.",
    prompt:
      "Proofread {{document_path}} and save the corrected version to {{output_path}}.\n\n" +
      "Fix:\n" +
      "- Spelling, grammar and punctuation.\n" +
      "- Broken sentences and run-on sentences.\n" +
      "- Inconsistent capitalisation and terminology — if the document uses 'the Agent' and 'agent' in the same paragraph, pick one.\n" +
      "- Broken markdown: unbalanced code fences, wrong heading levels, tables that do not line up.\n" +
      "- Broken links: check the relative paths actually resolve to files that exist.\n\n" +
      "Do not rewrite the argument, change the meaning, or shorten it. Keep the author's voice.\n\n" +
      "List every change you made in {{changes_path}}, old text to new text, so the author can review them.",
    fields: [
      { name: "document_path", label: "Document to proofread", type: "text", default: "/workspace/docs/guide.md" },
      { name: "output_path", label: "Where to write the corrected file", type: "text", default: "/workspace/docs/guide-corrected.md" },
      { name: "changes_path", label: "Where to list the changes", type: "text", default: "/workspace/docs/changes.md" },
    ],
    role: "technical-writer",
    estimatedMinutes: 15,
    tools: ["read_file", "write_file", "bash"],
    mcp: [],
    example:
      "guide-corrected.md written; 34 changes listed in changes.md.\n" +
      "  'the agent runs on it own machine' -> 'the agent runs on its own machine'\n" +
      "  'click on Save' -> 'click Save'\n" +
      "  2 unbalanced code fences fixed\n" +
      "  1 broken relative link: '../getting-started.md' -> the file does not exist; replaced with './getting-started.md' which does\n" +
      "  Terminology: 'the Agent'/'agent' made consistent as 'the agent'.",
  },
];
