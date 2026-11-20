import type { TaskTemplate } from "../types";

/** Category: build an app. */
export const BUILD_AN_APP: TaskTemplate[] = [
  {
    id: "rest-api-with-auth",
    category: "build-an-app",
    title: "Build a REST API with token auth",
    pitch: "A small HTTP API with bearer-token auth, SQLite storage and a README you can run.",
    prompt:
      "Build a REST API in {{language}} named {{project_name}} that manages {{resource}} records.\n\n" +
      "Requirements:\n" +
      "- Endpoints: list, get by id, create, update, delete for {{resource}}.\n" +
      "- Authentication: a static bearer token read from the {{env_var}} environment variable. Every request without a matching token gets 401.\n" +
      "- Storage: SQLite at {{storage_path}}, with a schema that matches the fields you choose for {{resource}}.\n" +
      "- Validate input and return JSON errors in the shape {\"error\": \"message\"} with the right status code.\n" +
      "- Write a README with the setup steps, the curl example for each endpoint, and how to rotate the token.\n\n" +
      "Work in {{directory}}, run the test suite you write, and report the exact commands you ran.",
    fields: [
      { name: "language", label: "Language and framework", type: "select", options: ["TypeScript + Express", "TypeScript + Fastify", "Python + FastAPI", "Go + net/http", "Rust + Axum"], default: "TypeScript + Express" },
      { name: "project_name", label: "Project name", type: "text", default: "notes-api" },
      { name: "resource", label: "What the API manages", type: "text", placeholder: "notes, customers, tasks…", default: "notes" },
      { name: "env_var", label: "Environment variable holding the token", type: "text", default: "API_TOKEN" },
      { name: "storage_path", label: "Database file path", type: "text", default: "./data/app.db" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace" },
    ],
    role: "backend-engineer",
    estimatedMinutes: 25,
    tools: ["write_file", "edit_file", "bash", "read_file"],
    mcp: [],
    example:
      "notes-api/ is a TypeScript + Express service.\n" +
      "  GET    /notes        (Bearer token required)\n" +
      "  GET    /notes/:id\n" +
      "  POST   /notes        {title, body}\n" +
      "  PATCH  /notes/:id\n" +
      "  DELETE /notes/:id\n" +
      "Storage: SQLite at ./data/app.db, table notes(id, title, body, created_at).\n" +
      "Tests: 12 passing (npm test) — auth rejection, CRUD round-trip, 404 and 400 paths.",
  },
  {
    id: "responsive-landing-page",
    category: "build-an-app",
    title: "Design a responsive landing page",
    pitch: "A polished, mobile-first landing page with a hero, feature grid, pricing and a footer.",
    prompt:
      "Design and build a responsive landing page for {{product_name}}, a {{product_description}}.\n\n" +
      "Requirements:\n" +
      "- Sections: sticky header with nav and a CTA, hero with a headline and one primary button, a three-up feature grid, a pricing table with {{pricing_tiers}} tiers, an FAQ, and a footer.\n" +
      "- Brand colour: {{brand_color}}. Use it consistently for buttons, links and accents.\n" +
      "- Mobile-first: it must read well at 375px and at 1440px. No horizontal scrolling at any width.\n" +
      "- Semantic HTML, visible focus rings, and a colour contrast ratio of at least 4.5:1 for body text.\n" +
      "- No layout shift on load: reserve space for images and use system font fallbacks.\n\n" +
      "Write the markup and styles in {{directory}} and screenshot the result at mobile and desktop widths so I can see it.",
    fields: [
      { name: "product_name", label: "Product name", type: "text", default: "Northwind" },
      { name: "product_description", label: "One-line description", type: "text", default: "team planning tool that keeps standups short" },
      { name: "pricing_tiers", label: "Number of pricing tiers", type: "select", options: ["2", "3", "4"], default: "3" },
      { name: "brand_color", label: "Brand colour", type: "text", placeholder: "#0ea5a4", default: "#22d3ee" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace/site" },
    ],
    role: "frontend-engineer",
    estimatedMinutes: 20,
    tools: ["write_file", "edit_file", "browser", "bash"],
    mcp: [],
    example:
      "Landing page at /workspace/site/index.html (single file, no build step).\n" +
      "  • Hero: 'Standups that end in five minutes' + one cyan CTA\n" +
      "  • Feature grid: 3 cards (Async standups, Auto-summaries, Slack)\n" +
      "  • Pricing: Free / Team $8 / Enterprise custom\n" +
      "  • FAQ: 5 questions, footer with links\n" +
      "Screenshots captured at 375px and 1440px — no horizontal scroll, focus rings visible.",
  },
  {
    id: "cli-tool-for-files",
    category: "build-an-app",
    title: "Build a command-line tool",
    pitch: "A single-binary CLI that does one job well, with --help, exit codes and tests.",
    prompt:
      "Write a command-line tool in {{language}} called {{tool_name}} that {{tool_purpose}}.\n\n" +
      "Requirements:\n" +
      "- Usage: {{tool_name}} {{cli_usage}}. Every flag has a short and a long form, and --help prints the usage with one line of explanation per flag.\n" +
      "- Reads from {{input_source}} and writes to {{output_target}}.\n" +
      "- Exit codes: 0 success, 1 nothing to do, 2 bad usage, 3 the operation failed.\n" +
      "- Errors go to stderr with a clear message; stdout carries only the result, so the tool composes in a pipeline.\n" +
      "- Include a test file covering the happy path, an empty input and one failure.\n\n" +
      "Put the project in {{directory}} and show me the --help output and the test results.",
    fields: [
      { name: "language", label: "Language", type: "select", options: ["Go", "Rust", "Python", "TypeScript (Node)"], default: "Go" },
      { name: "tool_name", label: "Tool name", type: "text", default: "logtail" },
      { name: "tool_purpose", label: "What the tool does", type: "text", placeholder: "prints the last N unique lines of a log file", default: "prints the last N unique lines of a log file" },
      { name: "cli_usage", label: "Usage line", type: "text", default: "--file <path> [--lines <n>]" },
      { name: "input_source", label: "Where the input comes from", type: "select", options: ["a file passed with --file", "stdin", "a directory path"], default: "stdin" },
      { name: "output_target", label: "Where the output goes", type: "select", options: ["stdout", "a file passed with --out", "stdout and a summary on stderr"], default: "stdout" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace" },
    ],
    role: "implementer",
    estimatedMinutes: 20,
    tools: ["write_file", "bash", "edit_file"],
    mcp: [],
    example:
      "logtail — print the last N unique lines of a log stream.\n" +
      "Usage: logtail --file <path> [--lines <n>]\n" +
      "  --file, -f   log file to read (default: stdin)\n" +
      "  --lines, -n  how many lines to keep (default: 50)\n" +
      "  --help, -h   show this help\n" +
      "Exit codes: 0 ok, 1 empty input, 2 bad usage, 3 read failure.\n" +
      "Tests: 6 passing (go test ./...).",
  },
  {
    id: "realtime-chat-app",
    category: "build-an-app",
    title: "Build a real-time chat app",
    pitch: "Two browser tabs, live messages over WebSockets, and history that survives a reload.",
    prompt:
      "Build a small real-time chat application called {{app_name}} in {{directory}}.\n\n" +
      "Requirements:\n" +
      "- The server is {{stack}} and serves the web page and a WebSocket endpoint at {{ws_path}}.\n" +
      "- Messages are broadcast to every connected client and stored in memory so a page reload shows the last {{history_size}} messages.\n" +
      "- Each message shows the sender name and a timestamp; the client scrolls to the newest message automatically.\n" +
      "- Sending a message is optimistic: it appears immediately, and shows 'failed' if the socket is disconnected.\n" +
      "- A nickname is asked for once and stored in localStorage.\n\n" +
      "Show it working: open two browser tabs against your server, send a message from one, and screenshot both tabs.",
    fields: [
      { name: "app_name", label: "App name", type: "text", default: "sidechat" },
      { name: "stack", label: "Stack", type: "select", options: ["Node + ws", "Node + Socket.IO", "Python + websockets", "Go + gorilla/websocket"], default: "Node + ws" },
      { name: "ws_path", label: "WebSocket path", type: "text", default: "/ws" },
      { name: "history_size", label: "Messages kept in memory", type: "text", default: "50" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace/chat" },
    ],
    role: "frontend-engineer",
    estimatedMinutes: 25,
    tools: ["write_file", "edit_file", "browser", "bash"],
    mcp: [],
    example:
      "sidechat/ — Node + ws, page at / and socket at /ws.\n" +
      "  • Nickname prompt on first load, stored in localStorage\n" +
      "  • Broadcast to every client; last 50 messages kept server-side\n" +
      "  • Optimistic send; 'failed' badge when the socket is down\n" +
      "Verified in two browser tabs: a message sent in tab A appeared in tab B immediately (screenshots of both).",
  },
  {
    id: "cron-job-runner",
    category: "build-an-app",
    title: "Build a cron-style job runner",
    pitch: "A scheduler that runs shell commands on an interval, logs each run and never double-runs.",
    prompt:
      "Build a small job runner in {{language}} at {{directory}} that executes shell commands on a schedule.\n\n" +
      "Requirements:\n" +
      "- Jobs are defined in a {{config_format}} config file: a name, a cron expression and a shell command for each.\n" +
      "- Each run's stdout, stderr and exit code are appended to a per-job log file under {{log_dir}}, with a timestamped header.\n" +
      "- A job never overlaps itself: if the previous run is still going, the new tick is skipped and that is logged.\n" +
      "- On startup, print the next fire time for every job so I can see the schedule.\n" +
      "- Include a --once flag that runs every job immediately and exits, which makes the tool testable.\n\n" +
      "Show me the --once output and the log file it produced.",
    fields: [
      { name: "language", label: "Language", type: "select", options: ["TypeScript (Node)", "Python", "Go", "Rust"], default: "TypeScript (Node)" },
      { name: "config_format", label: "Config format", type: "select", options: ["YAML", "JSON", "TOML"], default: "YAML" },
      { name: "log_dir", label: "Log directory", type: "text", default: "./logs" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace/runner" },
    ],
    role: "backend-engineer",
    estimatedMinutes: 20,
    tools: ["write_file", "bash", "edit_file"],
    mcp: [],
    example:
      "runner/ — Node + TypeScript, jobs.yaml:\n" +
      "  backup: '0 3 * * *'  -> tar czf /tmp/backup.tgz /workspace/data\n" +
      "  ping:   '*/5 * * * *' -> curl -fsS https://example.com/health\n" +
      "Logs: ./logs/backup.log, ./logs/ping.log (timestamped header per run).\n" +
      "--once ran both jobs: backup exit 0, ping exit 0. Overlap guard logged 'skipped: previous run still active'.",
  },
  {
    id: "todo-app-with-persistence",
    category: "build-an-app",
    title: "Build a todo app that persists",
    pitch: "Add, complete and delete todos that survive a page refresh, with keyboard support.",
    prompt:
      "Build a todo application called {{app_name}} in {{directory}} using {{stack}}.\n\n" +
      "Requirements:\n" +
      "- Add a todo with Enter or the send button; the input clears afterwards and the new todo is focused again.\n" +
      "- Each todo can be marked done (strikethrough + dimmed), edited inline with Enter saving the change, and deleted.\n" +
      "- State persists across a page reload using {{persistence}}.\n" +
      "- Counts are shown at the bottom: {{count_labels}}.\n" +
      "- Keyboard only: tab through the list, Enter to edit, Escape to cancel an edit, Delete to remove.\n" +
      "- Empty state says 'Nothing to do yet' when the list is empty.\n\n" +
      "Keep it to one screen with no build step if you can, and tell me how to run it.",
    fields: [
      { name: "app_name", label: "App name", type: "text", default: "today" },
      { name: "stack", label: "Stack", type: "select", options: ["Plain HTML + vanilla JS", "React + Vite", "Svelte + Vite", "TypeScript + Node + HTML"], default: "Plain HTML + vanilla JS" },
      { name: "persistence", label: "How state persists", type: "select", options: ["localStorage", "a small JSON file on the server", "a SQLite database"], default: "localStorage" },
      { name: "count_labels", label: "Count labels at the bottom", type: "text", default: "remaining, completed, total" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace/todo" },
    ],
    role: "frontend-engineer",
    estimatedMinutes: 15,
    tools: ["write_file", "edit_file", "browser"],
    mcp: [],
    example:
      "today/ — single index.html, no build step. Open it in a browser.\n" +
      "  • Enter adds, input clears and refocuses\n" +
      "  • Click to toggle done (strikethrough), double-click to edit, Delete removes\n" +
      "  • Stored in localStorage under 'today.todos' — survives reload\n" +
      "  • Footer: 2 remaining · 3 completed · 5 total; empty state shows 'Nothing to do yet'.",
  },
  {
    id: "dockerize-existing-app",
    category: "build-an-app",
    title: "Dockerize an existing app",
    pitch: "A working Dockerfile, a compose file and a healthcheck so the app starts with one command.",
    prompt:
      "Take the project in {{directory}} and make it run in Docker.\n\n" +
      "Requirements:\n" +
      "- A multi-stage Dockerfile in {{language}} that builds the app and ends in a small runtime image.\n" +
      "- The container runs as a non-root user and listens on port {{port}}.\n" +
      "- No secrets baked into the image: anything sensitive is read from an environment variable at start-up, and you write a .env.example listing the names only.\n" +
      "- A docker-compose.yml that starts the app and its dependency {{service_name}}, with a named volume for persistent data.\n" +
      "- A HEALTHCHECK that hits {{health_path}} and reports healthy only when the app answers.\n" +
      "- A .dockerignore so node_modules, .git and build output stay out of the context.\n\n" +
      "Then build the image and run the compose stack, and report the container status.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace/app" },
      { name: "language", label: "Runtime", type: "select", options: ["Node", "Python", "Go", "Rust"], default: "Node" },
      { name: "port", label: "Port the app listens on", type: "text", default: "3000" },
      { name: "service_name", label: "Dependency service", type: "select", options: ["postgres", "redis", "mongo", "none"], default: "postgres" },
      { name: "health_path", label: "Health endpoint path", type: "text", default: "/health" },
    ],
    role: "devops",
    estimatedMinutes: 20,
    tools: ["write_file", "bash", "read_file"],
    mcp: [],
    example:
      "app/Dockerfile — multi-stage: builder installs deps and builds, runtime copies dist + node_modules only.\n" +
      "app/docker-compose.yml — app (port 3000) + postgres:16, named volume pgdata, env from .env.\n" +
      "app/.env.example — DATABASE_URL, PORT (names only).\n" +
      "HEALTHCHECK hits /health every 30s.\n" +
      "docker compose up -d built and ran: app healthy (health: ok), postgres healthy.",
  },
];
