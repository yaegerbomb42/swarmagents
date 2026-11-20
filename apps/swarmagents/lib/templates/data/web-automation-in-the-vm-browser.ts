import type { TaskTemplate } from "../types";

/** Category: web automation in the VM browser. */
export const WEB_AUTOMATION_IN_THE_VM_BROWSER: TaskTemplate[] = [
  {
    id: "scrape-a-webpage",
    category: "web-automation-in-the-vm-browser",
    title: "Scrape a list of pages",
    pitch: "A real browser visits each URL and a clean table comes out, with the failures listed.",
    prompt:
      "Use the browser in your VM to collect data from {{start_url}}.\n\n" +
      "For each page listed on the start page, open it and extract {{fields}}.\n\n" +
      "Requirements:\n" +
      "- Follow the pagination for up to {{max_pages}} pages.\n" +
      "- Write the results to {{output_path}} as CSV with one column per field.\n" +
      "- If a page fails to load or a field is missing, record the URL and the reason in {{failures_path}} — never invent a value.\n" +
      "- Respect a delay of {{delay_ms}}ms between requests.\n" +
      "- Save a screenshot of one representative page so I can see the browser actually visited it.\n\n" +
      "Report how many pages succeeded and how many failed.",
    fields: [
      { name: "start_url", label: "Start URL", type: "text", default: "https://books.toscrape.com/" },
      { name: "fields", label: "Fields to extract", type: "text", default: "title, price, availability" },
      { name: "max_pages", label: "Max pages", type: "text", default: "5" },
      { name: "output_path", label: "Where to write the CSV", type: "text", default: "/workspace/scraped.csv" },
      { name: "failures_path", label: "Where to write failures", type: "text", default: "/workspace/scraped-failures.txt" },
      { name: "delay_ms", label: "Delay between requests (ms)", type: "text", default: "500" },
    ],
    role: "browser-operator",
    estimatedMinutes: 20,
    tools: ["browser", "write_file", "read_file", "bash"],
    mcp: ["playwright-mcp"],
    example:
      "scraped.csv — 60 rows from 3 pages (max_pages 5, only 3 exist).\n" +
      "  columns: title, price, availability\n" +
      "  first row: 'A Light in the Attic | £51.77 | In stock'\n" +
      "scraped-failures.txt — 1 entry: https://books.toscrape.com/catalogue/page-99.html (HTTP 404).\n" +
      "Screenshot saved: /workspace/scraped-page-1.png — the browser really visited the site.",
  },
  {
    id: "fill-and-submit-a-form",
    category: "web-automation-in-the-vm-browser",
    title: "Fill and submit a web form",
    pitch: "The form gets filled from your data, submitted in the browser, and the result screenshotted.",
    prompt:
      "Open {{form_url}} in the browser and fill it in with the data below.\n\n" +
      "Values:\n{{form_values}}\n\n" +
      "Requirements:\n" +
      "- Fill every field, including the ones with {{select_control}} controls — pick the option whose text matches, not the first one.\n" +
      "- If a required field has no value in the list, stop and report which field is missing instead of guessing.\n" +
      "- Before submitting, screenshot the filled form so I can check it.\n" +
      "- Submit, then screenshot the confirmation page and quote the confirmation text exactly.\n" +
      "- Report the URL you ended on.\n\n" +
      "Do not submit anything that costs money or sends an email to a real person.",
    fields: [
      { name: "form_url", label: "Form URL", type: "text", default: "http://127.0.0.1:3777/contact" },
      { name: "form_values", label: "Field values", type: "textarea", default: "name: Ada Lovelace\nemail: ada@example.com\ntopic: Product question\nmessage: I have a question about the API." },
      { name: "select_control", label: "How select controls are filled", type: "text", default: "the visible option text" },
    ],
    role: "browser-operator",
    estimatedMinutes: 15,
    tools: ["browser", "read_file", "bash"],
    mcp: ["playwright-mcp"],
    example:
      "Filled the form at /contact: name, email, topic (selected 'Product question' from the dropdown), message.\n" +
      "Filled-form screenshot: /workspace/form-filled.png\n" +
      "Submitted. Landed on https://example.com/thanks (200).\n" +
      "Confirmation text on the page: 'Thanks Ada — we will reply to ada@example.com within one business day.'",
  },
  {
    id: "screenshot-and-compare",
    category: "web-automation-in-the-vm-browser",
    title: "Screenshot a page and check it",
    pitch: "A screenshot at each breakpoint, checked against the criteria you gave.",
    prompt:
      "Open {{url}} in the browser and check the page against these criteria:\n{{criteria}}\n\n" +
      "Requirements:\n" +
      "- Take a full-page screenshot at {{viewports}}.\n" +
      "- For each criterion, say pass or fail and quote the evidence: the element, its text, or the console error.\n" +
      "- If you find a problem, capture a screenshot of just that element.\n" +
      "- Report the browser console errors and any failed network request.\n\n" +
      "Save the screenshots under {{screenshot_dir}} and write the findings to {{output_path}}.",
    fields: [
      { name: "url", label: "Page to check", type: "text", default: "http://127.0.0.1:3777/" },
      { name: "criteria", label: "What to check", type: "textarea", default: "the heading is visible above the fold\nthe primary button says 'Get started'\nno element is wider than the viewport at 375px\nthe page has exactly one h1" },
      { name: "viewports", label: "Viewports", type: "text", default: "375x812 and 1440x900" },
      { name: "screenshot_dir", label: "Screenshot directory", type: "text", default: "/workspace/screenshots" },
      { name: "output_path", label: "Where to write the findings", type: "text", default: "/workspace/screenshots/findings.md" },
    ],
    role: "browser-operator",
    estimatedMinutes: 15,
    tools: ["browser", "bash", "write_file"],
    mcp: ["playwright-mcp"],
    example:
      "Checked http://127.0.0.1:3777/ at 375x812 and 1440x900.\n" +
      "  • heading above the fold — PASS (h1 'Your own persistent Linux computer' at y=210)\n" +
      "  • primary button label — PASS ('Launch Agent Workspace')\n" +
      "  • no horizontal overflow at 375px — FAIL (document.scrollWidth 402 > 375; the promo card is 28px too wide)\n" +
      "  • exactly one h1 — PASS\n" +
      "Console: 0 errors. Failed requests: none.\n" +
      "Screenshots: screenshots/375.png, screenshots/1440.png, screenshots/overflow.png.",
  },
  {
    id: "log-in-and-read-data",
    category: "web-automation-in-the-vm-browser",
    title: "Log in and read the data behind it",
    pitch: "The browser signs in with the credentials you give, then reads the page you care about.",
    prompt:
      "Sign in to {{url}} in the browser and then read {{page_description}}.\n\n" +
      "Credentials:\n" +
      "  username: {{username}}\n" +
      "  password: {{password}}\n\n" +
      "Requirements:\n" +
      "- Log in through the form on the site. Do not put the password in the URL or in a script that is saved to disk.\n" +
      "- Navigate to {{target_page}} and extract {{fields}}.\n" +
      "- Write the result to {{output_path}}.\n" +
      "- Do not print the password in your output, in any file you write, or in a screenshot name.\n" +
      "- If the login is refused or the site shows a captcha, stop and report that instead of working around it.\n\n" +
      "Report the final URL and the number of rows you extracted.",
    fields: [
      { name: "url", label: "Login URL", type: "text", default: "https://example.com/login" },
      { name: "username", label: "Username", type: "text", default: "demo@example.com" },
      { name: "password", label: "Password", type: "text", default: "hunter2" },
      { name: "target_page", label: "Page to read after login", type: "text", default: "/orders" },
      { name: "page_description", label: "What to read", type: "text", default: "the list of open orders" },
      { name: "fields", label: "Fields to extract", type: "text", default: "order id, customer, total, status" },
      { name: "output_path", label: "Where to write the result", type: "text", default: "/workspace/orders.csv" },
    ],
    role: "browser-operator",
    estimatedMinutes: 20,
    tools: ["browser", "write_file", "read_file"],
    mcp: ["playwright-mcp"],
    example:
      "Logged in at https://example.com/login and read /orders.\n" +
      "  extracted 24 rows -> orders.csv (order_id, customer, total, status)\n" +
      "  final URL: https://example.com/orders\n" +
      "The password does not appear in any file or in this report; it was typed into the form and never written down.",
  },
  {
    id: "watch-a-page-for-a-change",
    category: "web-automation-in-the-vm-browser",
    title: "Watch a page for a change",
    pitch: "A poll loop that compares the page against the first snapshot and reports the difference.",
    prompt:
      "Watch {{url}} in the browser and tell me when it changes.\n\n" +
      "What to watch: {{watch_for}}\n\n" +
      "How:\n" +
      "1. Load the page once and save the {{watch_for}} as the baseline.\n" +
      "2. Reload every {{interval_seconds}} seconds for {{duration_minutes}} minutes.\n" +
      "3. Compare each load against the baseline. Report the first change, then keep watching until the time is up.\n" +
      "4. When something changes, save a screenshot of the changed state and quote what is different.\n\n" +
      "Write a timeline of every check to {{output_path}}, including the checks where nothing changed.",
    fields: [
      { name: "url", label: "Page to watch", type: "text", default: "https://status.example.com" },
      { name: "watch_for", label: "What to watch", type: "text", default: "the status banner text" },
      { name: "interval_seconds", label: "Poll interval (seconds)", type: "text", default: "30" },
      { name: "duration_minutes", label: "How long to watch (minutes)", type: "text", default: "5" },
      { name: "output_path", label: "Where to write the timeline", type: "text", default: "/workspace/watch-timeline.md" },
    ],
    role: "browser-operator",
    estimatedMinutes: 15,
    tools: ["browser", "bash", "write_file"],
    mcp: ["playwright-mcp"],
    example:
      "watch-timeline.md — 10 checks over 5 minutes, 30s apart.\n" +
      "  14:02 baseline 'All systems operational'\n" +
      "  14:04 … 14:17 unchanged (8 checks)\n" +
      "  14:19 CHANGED: banner now reads 'Degraded performance — elevated error rates'\n" +
      "  14:20 … 14:32 still degraded\n" +
      "Screenshot of the changed state: /workspace/changed-1419.png",
  },
  {
    id: "test-a-user-flow",
    category: "web-automation-in-the-vm-browser",
    title: "Test a user flow end to end",
    pitch: "The whole flow driven in the browser, with a screenshot at each step and a verdict.",
    prompt:
      "Test this user flow on {{url}} in the browser:\n{{flow}}\n\n" +
      "Requirements:\n" +
      "- Drive the flow exactly as described, in the browser. Do not shortcut it by calling the API.\n" +
      "- Take a screenshot after each step and name it after the step.\n" +
      "- At the end, state whether the flow passes, and quote the text that proves it — the confirmation banner, the new row, the final URL.\n" +
      "- If a step fails, stop there, screenshot the failure, and report exactly what was on screen. Do not retry more than twice.\n" +
      "- Note any console errors or failed requests along the way.\n\n" +
      "Write the step-by-step result to {{output_path}}.",
    fields: [
      { name: "url", label: "App URL", type: "text", default: "http://127.0.0.1:3777/" },
      { name: "flow", label: "The flow to test", type: "textarea", default: "1. Open the page\n2. Click 'Launch Agent Workspace'\n3. Type 'hello' in the prompt bar and press Enter\n4. Wait for the run to finish" },
      { name: "output_path", label: "Where to write the result", type: "text", default: "/workspace/flow-test.md" },
    ],
    role: "browser-operator",
    estimatedMinutes: 20,
    tools: ["browser", "bash", "write_file"],
    mcp: ["playwright-mcp"],
    example:
      "flow-test.md — 4 steps, all passed.\n" +
      "  1. Open http://127.0.0.1:3777/ — step1-open.png\n" +
      "  2. Clicked 'Launch Agent Workspace' — workspace visible — step2-launch.png\n" +
      "  3. Typed 'hello' and pressed Enter — run started — step3-prompt.png\n" +
      "  4. Run finished — terminal shows 'run finished · exit 0' — step4-done.png\n" +
      "Console errors: 0. Failed requests: 0.",
  },
  {
    id: "collect-links-from-a-site",
    category: "web-automation-in-the-vm-browser",
    title: "Collect the links from a site",
    pitch: "Every internal link, deduplicated, with the text you can click to find it again.",
    prompt:
      "Crawl {{url}} and collect every link that stays on the same site, up to {{max_pages}} pages.\n\n" +
      "Requirements:\n" +
      "- Follow links breadth-first from the start page.\n" +
      "- Record each link's absolute URL, its anchor text, and the page it was found on.\n" +
      "- Deduplicate by URL, but keep every distinct anchor text.\n" +
      "- Skip links that point to file types other than {{allowed_extensions}}.\n" +
      "- Write {{output_path}} as CSV and report how many pages and links you saw.\n\n" +
      "Stay on the site you were given: do not follow a link to a different domain.",
    fields: [
      { name: "url", label: "Start URL", type: "text", default: "https://example.com/docs" },
      { name: "max_pages", label: "Max pages", type: "text", default: "20" },
      { name: "allowed_extensions", label: "Allowed file types", type: "text", default: "html, pdf" },
      { name: "output_path", label: "Where to write the CSV", type: "text", default: "/workspace/links.csv" },
    ],
    role: "browser-operator",
    estimatedMinutes: 20,
    tools: ["browser", "write_file", "bash"],
    mcp: ["playwright-mcp"],
    example:
      "links.csv — 12 pages visited, 87 unique URLs.\n" +
      "  columns: url, anchor_text, found_on\n" +
      "  example row: https://example.com/docs/quickstart | Quickstart | https://example.com/docs\n" +
      "Skipped 14 external-domain links and 3 .zip files (allowed types: html, pdf).",
  },
  {
    id: "automate-a-download",
    category: "web-automation-in-the-vm-browser",
    title: "Automate a download",
    pitch: "The browser downloads the file, and you verify it is the file you asked for.",
    prompt:
      "Download {{what_to_download}} from {{url}} using the browser in your VM.\n\n" +
      "Requirements:\n" +
      "- Save it to {{download_dir}} with the filename {{filename}}.\n" +
      "- Verify the download: report the file size, its type, and a checksum. If it is an archive, list what is inside it.\n" +
      "- If the download needs a click on a button, find the button by its text and click it.\n" +
      "- If the download fails, report the HTTP status and what the page said instead.\n\n" +
      "Tell me the final path of the file and what is in it.",
    fields: [
      { name: "url", label: "Page to download from", type: "text", default: "https://example.com/releases" },
      { name: "what_to_download", label: "What to download", type: "text", default: "the latest release archive" },
      { name: "download_dir", label: "Directory to save into", type: "text", default: "/workspace/downloads" },
      { name: "filename", label: "Filename to save as", type: "text", default: "release.tar.gz" },
    ],
    role: "browser-operator",
    estimatedMinutes: 15,
    tools: ["browser", "bash", "read_file"],
    mcp: ["playwright-mcp"],
    example:
      "Downloaded via the 'Download latest' button at https://example.com/releases.\n" +
      "  saved: /workspace/downloads/release.tar.gz\n" +
      "  size: 4,182,331 bytes\n" +
      "  type: gzip compressed tar (file reports 'POSIX tar archive')\n" +
      "  sha256: 9f2c1a...d41b\n" +
      "  contents: bin/, README.md, LICENSE",
  },
];
