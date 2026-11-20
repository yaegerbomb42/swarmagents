import type { TaskTemplate } from "../types";

/** Category: personal productivity. */
export const PERSONAL_PRODUCTIVITY: TaskTemplate[] = [
  {
    id: "plan-your-week",
    category: "personal-productivity",
    title: "Plan the week",
    pitch: "Your tasks, your hours, and a realistic week with the conflicts named.",
    prompt:
      "Plan my week. Here is what I have to get done:\n{{tasks}}\n\n" +
      "Constraints:\n" +
      "- Working hours: {{working_hours}}.\n" +
      "- Fixed commitments that cannot move: {{commitments}}.\n" +
      "- I want at least {{focus_hours}} hours of deep work per day, in blocks of at least 90 minutes.\n" +
      "- I need a {{break_minutes}}-minute break after each focus block.\n\n" +
      "Give me a schedule by day and hour. Mark which blocks are deep work and which are meetings. Name the conflicts you had to resolve and what you moved. Tell me what does not fit, and what I have to drop for the week to be realistic.",
    fields: [
      { name: "tasks", label: "What you have to do", type: "textarea", default: "Finish the payment integration (about 6 hours)\nWrite the Q3 report (4 hours)\nReview two PRs (1 hour each)\nReply to the support thread (30 min)" },
      { name: "working_hours", label: "Your working hours", type: "text", default: "09:00-17:30, Monday to Friday" },
      { name: "commitments", label: "Fixed commitments", type: "textarea", default: "Standup 09:30-09:45 daily\nDesign review Wednesday 14:00-15:00\n1:1 Friday 15:00-15:30" },
      { name: "focus_hours", label: "Deep work hours per day", type: "text", default: "3" },
      { name: "break_minutes", label: "Break length (minutes)", type: "text", default: "15" },
    ],
    role: "orchestrator",
    estimatedMinutes: 10,
    tools: ["write_file"],
    mcp: [],
    example:
      "Monday\n" +
      "  09:00-09:30 standup\n" +
      "  09:45-11:15 deep work — payment integration (block 1)\n" +
      "  11:15-11:30 break\n" +
      "  11:30-13:00 deep work — payment integration (block 2)\n" +
      "  14:00-16:00 deep work — Q3 report\n" +
      "  16:00-17:00 support thread + PR reviews\n\n" +
      "Conflicts resolved: the Q3 report needs 4 hours and only 3 fit on Monday, so 1 hour moved to Tuesday morning.\n" +
      "Does not fit: two of the three PR reviews. Dropping one is the smallest cut — say which and I will drop it.",
  },
  {
    id: "write-a-weekly-update",
    category: "personal-productivity",
    title: "Write a weekly update",
    pitch: "What moved, what is stuck and what you need — four short sections.",
    prompt:
      "Write my weekly update from these notes:\n{{notes}}\n\n" +
      "It goes to {{audience}}, so keep it {{tone}}.\n\n" +
      "Structure, four short sections:\n" +
      "1. **Done** — what actually shipped or closed, with the outcome, not the activity.\n" +
      "2. **In progress** — one line each, with where it stands.\n" +
      "3. **Stuck** — what is blocked, what you tried, and what you need from whom.\n" +
      "4. **Next** — the top three things for the week ahead.\n\n" +
      "Under {{length}}. Use the numbers from the notes — no invented progress. If a section has nothing in it, write 'Nothing this week' rather than padding it.",
    fields: [
      { name: "notes", label: "Your notes", type: "textarea", default: "shipped the retry fix, 3 PRs merged\nstill waiting on the vendor for the API key, chased twice\npayment integration: 60% done, blocked on the webhook docs\nhired two interns starting in December" },
      { name: "audience", label: "Who reads it", type: "text", default: "my manager and the team" },
      { name: "tone", label: "Tone", type: "select", options: ["plain", "formal", "upbeat"], default: "plain" },
      { name: "length", label: "Length", type: "select", options: ["very short", "short", "detailed"], default: "short" },
    ],
    role: "technical-writer",
    estimatedMinutes: 10,
    tools: ["write_file"],
    mcp: [],
    example:
      "**Done**\n" +
      "- The retry fix shipped — failed webhooks now retry three times instead of being dropped.\n" +
      "- Two interns joining in December.\n\n" +
      "**In progress**\n" +
      "- Payment integration at 60%. Waiting on the vendor's webhook documentation.\n\n" +
      "**Stuck**\n" +
      "- Vendor API key, chased twice (last on the 4th). Need someone with a contract to push it.\n\n" +
      "**Next**\n" +
      "1. Finish the payment integration once the webhook docs arrive.\n" +
      "2. Instrument the retry path so we can see the drop rate.\n" +
      "3. Draft the December intern onboarding.",
  },
  {
    id: "organize-your-files",
    category: "personal-productivity",
    title: "Tidy a folder",
    pitch: "A plan first, then the move — with a dry run so nothing is lost.",
    prompt:
      "Organise the folder {{directory}}.\n\n" +
      "Here is what is in it:\n{{contents}}\n\n" +
      "Do this in order:\n" +
      "1. Propose a structure: which subfolders, which naming convention, and which files stay at the top level. Explain the rule you used, so it can be applied again.\n" +
      "2. Print a dry-run table of every move: from, to, and why.\n" +
      "3. Only after the table, make the moves. Nothing gets deleted — files that fit nowhere go into an 'unsorted' folder.\n" +
      "4. Write the dry-run table to {{log_path}} so the moves can be reversed.\n\n" +
      "Never overwrite a file: if the destination exists, add a numbered suffix and say so.",
    fields: [
      { name: "directory", label: "Folder to organise", type: "text", default: "/workspace/downloads" },
      { name: "contents", label: "What is in it", type: "textarea", default: "invoice-2026-03.pdf\ninvoice-2026-04.pdf\nIMG_2231.jpg, IMG_2232.jpg\nnotes.txt\nfinal_final_v2.docx\nsetup script.sh" },
      { name: "log_path", label: "Where to write the move log", type: "text", default: "/workspace/downloads/moves.md" },
    ],
    role: "main",
    estimatedMinutes: 15,
    tools: ["bash", "read_file", "write_file"],
    mcp: [],
    example:
      "Rule: one folder per kind (invoices, photos, docs, scripts), files named by kind and date.\n" +
      "Dry run (also written to moves.md):\n" +
      "  invoice-2026-03.pdf -> invoices/2026-03-invoice.pdf\n" +
      "  IMG_2231.jpg -> photos/2026-05-04-IMG_2231.jpg\n" +
      "  final_final_v2.docx -> docs/2026-05-04-notes.docx\n" +
      "  setup script.sh -> scripts/setup.sh\n" +
      "  notes.txt -> unsorted/notes.txt (no rule matched it)\n" +
      "Nothing deleted. No destination existed, so no numbered suffixes were needed.",
  },
  {
    id: "plan-a-project",
    category: "personal-productivity",
    title: "Break a project into steps",
    pitch: "A plan with dependencies, risks and the first thing to do this week.",
    prompt:
      "Here is the project I want to do:\n{{project}}\n\n" +
      "Turn it into a plan:\n" +
      "- Break it into steps that each end in something checkable. No step called 'research' or 'build the backend'.\n" +
      "- For each step: what it produces, roughly how long it takes, and what it depends on.\n" +
      "- Put the steps in order, and say which ones can run in parallel.\n" +
      "- Name the {{risk_count}} biggest risks and, for each, the cheapest thing that would catch it early.\n" +
      "- Say what to do first — the single step that unlocks the most.\n\n" +
      "Be concrete about deliverables. Write it to {{output_path}}.",
    fields: [
      { name: "project", label: "The project", type: "textarea", default: "Launch a customer-facing status page that shows live service health and incident history." },
      { name: "risk_count", label: "How many risks to name", type: "text", default: "3" },
      { name: "output_path", label: "Where to write the plan", type: "text", default: "/workspace/plan.md" },
    ],
    role: "orchestrator",
    estimatedMinutes: 15,
    tools: ["write_file"],
    mcp: [],
    example:
      "# Status page plan\n\n" +
      "1. Health endpoint per service (2h) — produces: /health on each service, checked by curl\n" +
      "2. Status aggregation service (3h) — depends on 1\n" +
      "3. Public page that polls it (4h) — depends on 2\n" +
      "4. Incident history store and admin form (4h) — can run in parallel with 2\n" +
      "5. Domain, TLS and cache headers (1h) — depends on 3\n\n" +
      "Risks: the aggregation service becomes a single point of failure (catch it by polling it every minute from a second host); status flaps on a 1-second blip (catch it by requiring 3 consecutive failures before showing degraded); no one writes incidents (catch it by writing the first 10 by hand before launch).\n\n" +
      "Do first: step 1 — without a health endpoint nothing else can report anything.",
  },
  {
    id: "prepare-for-a-meeting",
    category: "personal-productivity",
    title: "Prepare for a meeting",
    pitch: "The agenda, the questions, and the two minutes of prep that decide the meeting.",
    prompt:
      "Prepare me for a meeting about {{meeting_topic}}.\n\n" +
      "Here is the context I have:\n{{context}}\n\n" +
      "Give me:\n" +
      "- A one-line statement of what a good outcome of this meeting looks like.\n" +
      "- An agenda of at most {{agenda_items}} items, each with a time box, and the outcome you want from it.\n" +
      "- The questions I should ask, including the two whose answers would change my recommendation.\n" +
      "- What I should not agree to in the room, and the reason.\n" +
      "- A two-minute summary I can read on the way in.\n\n" +
      "Base everything on the context I gave. Where the context does not settle a question, say so rather than inventing a fact.",
    fields: [
      { name: "meeting_topic", label: "Meeting topic", type: "text", default: "whether to move the billing service to the new provider" },
      { name: "context", label: "Context you have", type: "textarea", default: "The new provider is $400/month cheaper and supports the webhook we need. Migration is estimated at 3 weeks of one engineer's time. The current provider has a 99.9% SLA with a credit." },
      { name: "agenda_items", label: "Max agenda items", type: "text", default: "4" },
    ],
    role: "main",
    estimatedMinutes: 10,
    tools: ["write_file"],
    mcp: [],
    example:
      "A good outcome: a decision to migrate, with a named owner and a start date — or a clear 'no, and here is what would change it'.\n\n" +
      "Agenda (35 min):\n" +
      "  1. (10 min) What we would have to rebuild — three concrete changes, not a general risk list.\n" +
      "  2. (10 min) The provider's SLA and what happens when it breaches. Outcome: the number to compare against.\n" +
      "  3. (10 min) Cost of the 3 weeks of engineering, including the delay to the webhook feature.\n" +
      "  4. (5 min) Decision and owner.\n\n" +
      "Ask: what is the actual SLA credit when they breach? Is the 3-week estimate fixed-price? What is the rollback plan if the webhook differs from the spec?\n\n" +
      "Do not agree to a start date before the SLA question is answered — the saving is $400/month against 3 weeks of engineering, which is a much smaller margin if the SLA is not equivalent.\n\n" +
      "Two-minute version: the new provider saves $400/month and has the webhook we need, but moving costs about 3 weeks of engineering and the current SLA has a credit the new one may not. I want to know what the new SLA actually pays before I recommend the move.",
  },
  {
    id: "clean-up-your-inbox",
    category: "personal-productivity",
    title: "Triage a pile of messages",
    pitch: "Everything sorted into five buckets, with replies drafted for the ones that need one.",
    prompt:
      "Triage the messages below.\n\n{{messages}}\n\n" +
      "For each message, put it in exactly one bucket:\n" +
      "- **Reply now** — it is blocking someone or waiting on me, and I am the only one who can answer it.\n" +
      "- **Reply this week** — needs an answer, but not today.\n" +
      "- **Delegate** — someone else should handle it. Say who and why.\n" +
      "- **No reply** — it is informational or a notification. Say why in a few words.\n" +
      "- **Archive** — irrelevant to me now.\n\n" +
      "For the 'Reply now' and 'Reply this week' buckets, draft the reply — short, concrete, and something I can send after editing.\n\n" +
      "End with the total per bucket and the one message that is most overdue.",
    fields: [
      { name: "messages", label: "The messages", type: "textarea", default: "1. Ana: the staging deploy is blocked, can you approve the config change?\n2. Newsletter: 10 things in tech this week\n3. Bank: your statement is ready\n4. Priya: can you review the pricing doc before Thursday?\n5. Bot: build 1284 succeeded\n6. Tom: (no subject)" },
    ],
    role: "main",
    estimatedMinutes: 15,
    tools: ["write_file"],
    mcp: [],
    example:
      "**Reply now** — 1. Ana, staging is blocked on my approval.\n" +
      "  > Approved — the config change is fine. It should be live in staging in about ten minutes.\n\n" +
      "**Reply this week** — 4. Priya, the pricing doc.\n" +
      "  > I will read it tomorrow and get you comments by Wednesday.\n\n" +
      "**Delegate** — 6. Tom's message has no subject; it asks for the Q2 numbers.\n" +
      "  > Numbers go to Tom — ask finance for the Q2 export.\n\n" +
      "**No reply** — 2. Newsletter (summarised as 'nothing needing action'), 3. Bank statement, 5. Build 1284 succeeded.\n\n" +
      "**Archive** — none.\n\n" +
      "Totals: 1 reply now, 1 reply this week, 1 delegate, 3 no reply, 0 archive. Most overdue: Ana's, since it is blocking staging.",
  },
  {
    id: "summarize-a-meeting",
    category: "personal-productivity",
    title: "Turn meeting notes into actions",
    pitch: "Every decision, every owner, every date — and the things that were never decided.",
    prompt:
      "Turn these meeting notes into a record:\n{{notes}}\n\n" +
      "Produce:\n" +
      "- **Decisions** — what was decided, one line each, with the person who decided it.\n" +
      "- **Actions** — who does what by when. If a note says 'someone should look at the cache' and names nobody, write the owner as 'unassigned' and say so.\n" +
      "- **Open questions** — what was raised and not answered, with who owes the answer.\n" +
      "- **One-line summary** — what happened, for someone who missed it.\n\n" +
      "Do not invent owners or dates. If a date is only implied, write the implied date and mark it as implied.\n\n" +
      "Write the record to {{output_path}}.",
    fields: [
      { name: "notes", label: "Meeting notes", type: "textarea", default: "Decided to keep the old pricing for existing customers until March. Ana will draft the migration script. Someone should look at the cache layer, it is slow. Priya said the vendor contract is signed." },
      { name: "output_path", label: "Where to write the record", type: "text", default: "/workspace/meeting-record.md" },
    ],
    role: "main",
    estimatedMinutes: 10,
    tools: ["write_file"],
    mcp: [],
    example:
      "# Meeting record — pricing and performance\n\n" +
      "## Decisions\n" +
      "- Existing customers keep the old pricing until March. (decided in the meeting, no individual owner recorded)\n" +
      "- The vendor contract is signed. (Priya)\n\n" +
      "## Actions\n" +
      "- Ana — draft the pricing migration script. Due: not recorded.\n" +
      "- Unassigned — look at the cache layer; it is slow. No owner and no date were agreed.\n\n" +
      "## Open questions\n" +
      "- Who owns the cache work, and by when?\n\n" +
      "## Summary\n" +
      "Pricing stays frozen for existing customers until March, Ana is on the migration script, and the slow cache layer has no owner yet.",
  },
  {
    id: "set-up-a-habit-tracker",
    category: "personal-productivity",
    title: "Build a habit tracker",
    pitch: "A small script that records the habit and a chart that shows whether it is working.",
    prompt:
      "Build a habit tracker for {{habit}} in {{directory}}.\n\n" +
      "Requirements:\n" +
      "- A command to record today: `{{command_name}}`. It records the date in a plain text file under {{data_file}}, one line per entry, and does nothing if today is already recorded.\n" +
      "- A command to show the last {{window_days}} days as a table and a simple text bar chart, with a streak count.\n" +
      "- The habit is expected on {{expected_days}} — if it is not every day, the streak counts only the expected days.\n" +
      "- Data lives in a file, not a database. The file is plain text so it can be read and edited by hand.\n" +
      "- The script is idempotent and safe to run twice.\n\n" +
      "Run it a few times to show it working, and show the output.",
    fields: [
      { name: "habit", label: "The habit", type: "text", default: "a 20-minute walk" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace/habit" },
      { name: "command_name", label: "Command name", type: "text", default: "walk" },
      { name: "data_file", label: "Data file", type: "text", default: "./habit.log" },
      { name: "window_days", label: "Days to show", type: "text", default: "14" },
      { name: "expected_days", label: "Which days are expected", type: "select", options: ["every day", "weekdays", "Monday, Wednesday, Friday"], default: "every day" },
    ],
    role: "implementer",
    estimatedMinutes: 15,
    tools: ["write_file", "bash", "edit_file"],
    mcp: [],
    example:
      "habit.sh with two commands: 'walk' records today, 'walk --show' prints the last 14 days.\n" +
      "habit.log holds one ISO date per line:\n" +
      "  2026-11-10\n  2026-11-11\n  2026-11-12\n\n" +
      "Running 'walk' twice on the same day adds one line, not two.\n" +
      "walk --show:\n" +
      "  2026-11-11  done  ####\n" +
      "  2026-11-12  done  ####\n" +
      "  2026-11-13  --    \n" +
      "  streak: 2 days",
  },
];
