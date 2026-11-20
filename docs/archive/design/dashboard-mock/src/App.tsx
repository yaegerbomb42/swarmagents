/**
 * SwarmAgents — agent computer workspace (single-file component)
 * Deps: react, lucide-react, Tailwind classes only.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bug,
  Cable,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Cpu,
  Database,
  Eye,
  FilePen,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Globe,
  Hammer,
  Hand,
  HardDrive,
  Hexagon,
  Library,
  ListChecks,
  Loader2,
  Lock,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Telescope,
  Terminal as TerminalIcon,
  TriangleAlert,
  User,
  WandSparkles,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────────
   Types & helpers
──────────────────────────────────────────────────────────────────────────── */

type Scene = "empty" | "loading" | "running" | "approval" | "finished" | "error";
type Demo = Scene | "takeover";
type RoleId = "main" | "researcher" | "builder" | "reviewer" | "devops";
type Status = "running" | "finished" | "error";
type ToolKind = "terminal" | "browser" | "edit" | "read" | "search" | "git" | "shield" | "user";
type StepStatus = "done" | "running" | "error" | "waiting" | "paused";

interface Thread {
  id: string;
  title: string;
  role: RoleId;
  status: Status;
  cost: number;
  group: "Today" | "Yesterday" | "Older";
  time: string;
}
interface Step {
  id: string;
  tool: ToolKind;
  action: string;
  detail?: string;
  dur: string;
  status: StepStatus;
}

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");
const money = (n: number) => `$${n.toFixed(2)}`;
const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const uid = () => Math.random().toString(36).slice(2, 9);

/* ────────────────────────────────────────────────────────────────────────────
   Static design tokens + mock data
──────────────────────────────────────────────────────────────────────────── */

const ROLES: Record<
  RoleId,
  { name: string; desc: string; icon: LucideIcon; text: string; bg: string; ring: string }
> = {
  main: {
    name: "Main Agent",
    desc: "General purpose, plans and delegates",
    icon: Sparkles,
    text: "text-indigo-300",
    bg: "bg-indigo-400/10",
    ring: "ring-indigo-400/25",
  },
  researcher: {
    name: "Researcher",
    desc: "Browses, reads sources, cites",
    icon: Telescope,
    text: "text-sky-300",
    bg: "bg-sky-400/10",
    ring: "ring-sky-400/25",
  },
  builder: {
    name: "Builder",
    desc: "Writes, runs and fixes code",
    icon: Hammer,
    text: "text-amber-300",
    bg: "bg-amber-400/10",
    ring: "ring-amber-400/25",
  },
  reviewer: {
    name: "Reviewer",
    desc: "Reads diffs, finds risks",
    icon: Eye,
    text: "text-fuchsia-300",
    bg: "bg-fuchsia-400/10",
    ring: "ring-fuchsia-400/25",
  },
  devops: {
    name: "DevOps",
    desc: "Servers, CI, deploys, certs",
    icon: Server,
    text: "text-emerald-300",
    bg: "bg-emerald-400/10",
    ring: "ring-emerald-400/25",
  },
};

const THREADS: Thread[] = [
  { id: "t1", title: "Fix flaky checkout tests", role: "builder", status: "running", cost: 0.42, group: "Today", time: "now" },
  { id: "t2", title: "Compare vector DB pricing: pgvector, Qdrant, Pinecone", role: "researcher", status: "finished", cost: 0.18, group: "Today", time: "1h ago" },
  { id: "t3", title: "Review PR #482 · auth middleware", role: "reviewer", status: "finished", cost: 0.09, group: "Today", time: "2h ago" },
  { id: "t4", title: "Rotate staging TLS certificates", role: "devops", status: "error", cost: 0.21, group: "Today", time: "3h ago" },
  { id: "t5", title: "Migrate cron jobs to systemd timers", role: "devops", status: "finished", cost: 0.67, group: "Yesterday", time: "Yesterday" },
  { id: "t6", title: "Draft Q3 changelog from merged PRs", role: "main", status: "finished", cost: 0.05, group: "Yesterday", time: "Yesterday" },
  { id: "t7", title: "Benchmark Bun vs Node on /api/search", role: "researcher", status: "finished", cost: 0.31, group: "Older", time: "Mon" },
  { id: "t8", title: "Scaffold Stripe webhook handler", role: "builder", status: "finished", cost: 0.88, group: "Older", time: "Last week" },
  { id: "t9", title: "Audit npm dependencies for CVEs", role: "reviewer", status: "error", cost: 0.14, group: "Older", time: "Last week" },
];

const DEMOS: { id: Demo; label: string }[] = [
  { id: "empty", label: "Empty" },
  { id: "loading", label: "Loading" },
  { id: "running", label: "Running" },
  { id: "approval", label: "Approval" },
  { id: "finished", label: "Finished" },
  { id: "error", label: "Error" },
  { id: "takeover", label: "Take over" },
];

const DEMO_SEED: Record<Demo, { elapsed: number; n: number }> = {
  empty: { elapsed: 0, n: 41 },
  loading: { elapsed: 0, n: 41 },
  running: { elapsed: 187, n: 41 },
  approval: { elapsed: 164, n: 41 },
  finished: { elapsed: 252, n: 52 },
  error: { elapsed: 178, n: 49 },
  takeover: { elapsed: 187, n: 44 },
};

const TOTAL_TESTS = 52;
const TEST_FILES = [
  { name: "src/checkout/useCart.test.ts", count: 14 },
  { name: "src/checkout/CheckoutForm.test.tsx", count: 11 },
  { name: "src/lib/api.test.ts", count: 9 },
  { name: "src/checkout/payment.test.ts", count: 11 },
  { name: "src/checkout/shipping.test.ts", count: 7 },
];

const SUGGESTIONS = [
  "Fix the flaky checkout tests and open a PR",
  "Research Postgres vs ClickHouse for our analytics workload",
  "Set up nightly encrypted backups with restic",
];

/* ── Step history ─────────────────────────────────────────────────────────── */

const COMMON_STEPS: Step[] = [
  { id: "s1", tool: "read", action: "Read src/checkout/useCart.test.ts", detail: "212 lines", dur: "0.4s", status: "done" },
  { id: "s2", tool: "git", action: "git pull --rebase origin main", detail: "Already up to date", dur: "2.1s", status: "done" },
  { id: "s3", tool: "search", action: "grep -rn 'waitForTimeout' src/", detail: "9 matches in 3 files", dur: "0.3s", status: "done" },
  { id: "s4", tool: "edit", action: "Edit src/checkout/useCart.test.ts", detail: "+12 −7 · replaced sleeps with findBy*", dur: "1.2s", status: "done" },
  { id: "s5", tool: "browser", action: "Open localhost:5173/checkout", detail: "200 OK · 412 ms", dur: "3.4s", status: "done" },
];

function stepsFor(scene: Scene, control: boolean, paused: boolean): Step[] {
  switch (scene) {
    case "empty":
    case "loading":
      return [];
    case "approval":
      return [
        ...COMMON_STEPS,
        { id: "s6", tool: "terminal", action: "npx playwright install chromium", detail: "ENOSPC: no space left on device", dur: "2.9s", status: "error" },
        { id: "s7", tool: "terminal", action: "df -h /", detail: "94% used · 2.1G free", dur: "0.1s", status: "done" },
        { id: "s8", tool: "shield", action: "docker system prune -af --volumes", detail: "Waiting for your approval", dur: "—", status: "waiting" },
      ];
    case "finished":
      return [
        ...COMMON_STEPS,
        { id: "s6", tool: "terminal", action: "npm test", detail: "52/52 passed · 3 consecutive runs", dur: "21.4s", status: "done" },
        { id: "s7", tool: "git", action: "git commit -m 'test(checkout): remove timing races'", detail: "4 files", dur: "0.6s", status: "done" },
        { id: "s8", tool: "git", action: "gh pr create --fill --base main", detail: "PR #491 opened", dur: "1.9s", status: "done" },
      ];
    case "error":
      return [
        ...COMMON_STEPS,
        { id: "s6", tool: "terminal", action: "npm test", detail: "3 failed · exit code 1", dur: "7.1s", status: "error" },
      ];
    default:
      return [
        ...COMMON_STEPS,
        {
          id: "s6",
          tool: "terminal",
          action: "npm test",
          detail: "/workspace/app · vitest run",
          dur: "…",
          status: control || paused ? "paused" : "running",
        },
      ];
  }
}

/* ── Files + diffs ────────────────────────────────────────────────────────── */

interface FNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  st?: "M" | "A";
  add?: number;
  del?: number;
  children?: FNode[];
}
const f = (name: string, path: string, st?: "M" | "A", add?: number, del?: number): FNode => ({
  name, path, kind: "file", st, add, del,
});
const TREE: FNode = {
  name: "app", path: "app", kind: "dir",
  children: [
    { name: ".github", path: "app/.github", kind: "dir", children: [f("ci.yml", "app/.github/ci.yml")] },
    {
      name: "src", path: "app/src", kind: "dir",
      children: [
        {
          name: "checkout", path: "app/src/checkout", kind: "dir",
          children: [
            f("CheckoutForm.tsx", "app/src/checkout/CheckoutForm.tsx"),
            f("CheckoutForm.test.tsx", "app/src/checkout/CheckoutForm.test.tsx"),
            f("payment.test.ts", "app/src/checkout/payment.test.ts", "M", 9, 3),
            f("useCart.ts", "app/src/checkout/useCart.ts", "M", 4, 2),
            f("useCart.test.ts", "app/src/checkout/useCart.test.ts", "M", 12, 7),
            f("waitForCart.ts", "app/src/checkout/waitForCart.ts", "A", 18, 0),
          ],
        },
        { name: "lib", path: "app/src/lib", kind: "dir", children: [f("api.ts", "app/src/lib/api.ts"), f("api.test.ts", "app/src/lib/api.test.ts")] },
      ],
    },
    f("package.json", "app/package.json"),
    f("playwright.config.ts", "app/playwright.config.ts", "M", 2, 1),
    f("vitest.config.ts", "app/vitest.config.ts"),
  ],
};

type DL = { t: "ctx" | "add" | "del" | "hunk"; s: string };
const DIFFS: Record<string, DL[]> = {
  "app/src/checkout/useCart.test.ts": [
    { t: "hunk", s: "@@ -41,9 +41,14 @@ describe('useCart hydration')" },
    { t: "ctx", s: "  it('restores items from localStorage', async () => {" },
    { t: "ctx", s: "    const { result } = renderHook(() => useCart());" },
    { t: "del", s: "    await page.waitForTimeout(500);" },
    { t: "del", s: "    expect(result.current.items).toHaveLength(2);" },
    { t: "add", s: "    await waitForCart(result, (c) => c.status === 'ready');" },
    { t: "add", s: "    expect(result.current.items).toHaveLength(2);" },
    { t: "add", s: "    expect(result.current.subtotal).toBe(5600);" },
    { t: "ctx", s: "  });" },
  ],
  "app/src/checkout/useCart.ts": [
    { t: "hunk", s: "@@ -18,6 +18,8 @@ export function useCart()" },
    { t: "ctx", s: "  const [status, setStatus] = useState<'idle' | 'ready'>('idle');" },
    { t: "del", s: "  useEffect(() => { hydrate(); }, []);" },
    { t: "add", s: "  useEffect(() => {" },
    { t: "add", s: "    hydrate().then(() => setStatus('ready'));" },
    { t: "add", s: "  }, []);" },
  ],
  "app/src/checkout/waitForCart.ts": [
    { t: "hunk", s: "@@ -0,0 +1,8 @@" },
    { t: "add", s: "import { waitFor } from '@testing-library/react';" },
    { t: "add", s: "" },
    { t: "add", s: "export async function waitForCart<T>(ref: { current: T }, pred: (v: T) => boolean) {" },
    { t: "add", s: "  await waitFor(() => expect(pred(ref.current)).toBe(true), { timeout: 4000 });" },
    { t: "add", s: "}" },
  ],
  "app/src/checkout/payment.test.ts": [
    { t: "hunk", s: "@@ -84,7 +84,13 @@ describe('3DS challenge')" },
    { t: "ctx", s: "  it('retries card when 3DS challenge times out', async () => {" },
    { t: "del", s: "    vi.advanceTimersByTime(30_000);" },
    { t: "add", s: "    await vi.advanceTimersByTimeAsync(30_000);" },
    { t: "add", s: "    await flushPromises();" },
    { t: "ctx", s: "    expect(intent.status).toBe('succeeded');" },
  ],
  "app/playwright.config.ts": [
    { t: "hunk", s: "@@ -9,5 +9,6 @@ export default defineConfig({" },
    { t: "del", s: "  retries: 0," },
    { t: "add", s: "  retries: process.env.CI ? 2 : 0," },
    { t: "add", s: "  workers: process.env.CI ? 2 : undefined," },
  ],
};

/* ── Plan ─────────────────────────────────────────────────────────────────── */

type PlanState = "done" | "active" | "pending" | "failed";
function planFor(scene: Scene, n: number): { text: string; sub?: string; st: PlanState }[] {
  if (scene === "empty" || scene === "loading") return [];
  const base = [
    { text: "Reproduce the flaky failures locally", sub: "Failed 4 of 20 runs in CI, 0 of 20 locally", st: "done" as PlanState },
    { text: "Find the race in cart hydration", sub: "useCart resolves after first assertion", st: "done" as PlanState },
    { text: "Replace sleeps with findBy* / waitFor", sub: "9 call sites across 3 files", st: "done" as PlanState },
    { text: "Run the full suite 3× to confirm stability", sub: `Run 1 of 3 · ${n}/${TOTAL_TESTS} tests`, st: "active" as PlanState },
    { text: "Open a PR with before/after evidence", st: "pending" as PlanState },
  ];
  if (scene === "finished") return base.map((p, i) => ({ ...p, st: "done" as PlanState, sub: i === 3 ? "3 of 3 runs green · 52/52" : p.sub }));
  if (scene === "error") return base.map((p, i) => (i === 3 ? { ...p, st: "failed" as PlanState, sub: "payment.test.ts: 3 failed" } : p));
  if (scene === "approval") return base.map((p, i) => (i === 3 ? { ...p, sub: "Blocked: disk full, needs cleanup" } : p));
  return base;
}

/* ── Browser ──────────────────────────────────────────────────────────────── */

const BROWSER_TABS = [
  { id: "b1", title: "Checkout · Acme Storefront", url: "localhost:5173/checkout", color: "bg-indigo-400", meta: "200 OK · 412 ms · 38 requests" },
  { id: "b2", title: "Test retries | Playwright", url: "playwright.dev/docs/test-retries", color: "bg-emerald-400", meta: "200 OK · 188 ms · 21 requests" },
  { id: "b3", title: "fix: flaky checkout tests by Maya Kim · PR #491", url: "github.com/acme/storefront/pull/491", color: "bg-zinc-300", meta: "200 OK · 640 ms · 54 requests" },
];

/* ── Library ──────────────────────────────────────────────────────────────── */

type LibKey = "connectors" | "mcp" | "skills" | "tools";
interface LibItem { id: string; name: string; desc: string; icon: LucideIcon; on: boolean }
const LIB: Record<LibKey, LibItem[]> = {
  connectors: [
    { id: "gh", name: "GitHub", desc: "acme/storefront · repo, PRs, Actions", icon: GitBranch, on: true },
    { id: "lin", name: "Linear", desc: "Issues for team Checkout", icon: Workflow, on: true },
    { id: "sent", name: "Sentry", desc: "Read error events for web-prod", icon: Bug, on: true },
    { id: "slack", name: "Slack", desc: "#eng-alerts · post only", icon: MessageSquare, on: false },
    { id: "gd", name: "Google Drive", desc: "Read-only · shared drives", icon: HardDrive, on: false },
  ],
  mcp: [
    { id: "fs", name: "filesystem", desc: "/workspace · read & write", icon: FolderTree, on: true },
    { id: "pg", name: "postgres", desc: "staging-db · read-only role", icon: Database, on: true },
    { id: "pw", name: "playwright", desc: "Browser automation · chromium", icon: Globe, on: true },
    { id: "fetch", name: "fetch", desc: "HTTP requests, respects robots.txt", icon: Cable, on: false },
  ],
  skills: [
    { id: "vt", name: "Write Vitest tests", desc: "Prefers findBy* queries, no arbitrary sleeps", icon: WandSparkles, on: true },
    { id: "cc", name: "Conventional commits", desc: "feat / fix / chore with scope", icon: GitBranch, on: true },
    { id: "pr", name: "PR descriptions", desc: "Summary, risk, test evidence", icon: GitPullRequest, on: true },
    { id: "fl", name: "Debug flaky tests", desc: "Repeat runs, capture seeds, bisect", icon: Bug, on: false },
  ],
  tools: [
    { id: "term", name: "Terminal", desc: "Sandboxed bash · 2 vCPU / 4 GB", icon: TerminalIcon, on: true },
    { id: "br", name: "Browser", desc: "Chromium with persistent profile", icon: Globe, on: true },
    { id: "ed", name: "File editor", desc: "View, create, patch files", icon: FilePen, on: true },
    { id: "web", name: "Web search", desc: "Cited results, 5 per query", icon: Search, on: true },
    { id: "shot", name: "Screenshot", desc: "Capture and annotate the screen", icon: Camera, on: true },
    { id: "dock", name: "Docker", desc: "Destructive commands need approval", icon: Server, on: true },
  ],
};

/* ────────────────────────────────────────────────────────────────────────────
   Styles (keyframes, focus ring, reduced motion)
──────────────────────────────────────────────────────────────────────────── */

const CSS = `
.sa-root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
.sa-mono{font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,Consolas,monospace}
.sa-root :focus-visible{outline:2px solid #818cf8;outline-offset:2px}
.sa-root input:focus-visible,.sa-root textarea:focus-visible{outline:none}
.sa-caret::after{content:"";display:inline-block;width:7px;height:1.05em;margin-left:2px;vertical-align:-2px;background:#a5b4fc;animation:sa-blink 1s steps(1) infinite}
@keyframes sa-blink{50%{opacity:0}}
@keyframes sa-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.sa-in{animation:sa-in .28s cubic-bezier(.2,.8,.2,1) both}
@keyframes sa-shimmer{from{background-position:-200% 0}to{background-position:200% 0}}
.sa-shimmer{background:linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.09) 50%,rgba(255,255,255,.04) 75%);background-size:200% 100%;animation:sa-shimmer 1.6s linear infinite}
@keyframes sa-indet{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
.sa-indet{animation:sa-indet 1.8s ease-in-out infinite}
@keyframes sa-cursor{0%{transform:translate(560px,420px)}20%{transform:translate(720px,520px)}45%{transform:translate(900px,610px)}70%{transform:translate(480px,370px)}100%{transform:translate(560px,420px)}}
.sa-cursor{animation:sa-cursor 14s ease-in-out infinite}
.sa-scroll{scrollbar-width:thin;scrollbar-color:#2a2a30 transparent}
.sa-grid{background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:32px 32px;mask-image:radial-gradient(ellipse at center,#000 30%,transparent 75%)}
@media (prefers-reduced-motion:reduce){.sa-root *,.sa-root *::before,.sa-root *::after{animation:none!important;transition:none!important}}
`;

/* ────────────────────────────────────────────────────────────────────────────
   Hooks
──────────────────────────────────────────────────────────────────────────── */

function useMedia(query: string) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const h = () => setM(mq.matches);
    h();
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [query]);
  return m;
}

/** Streams text char-by-char; when only the tail changes, only the tail re-streams. */
function useTypewriter(text: string, speed = 14) {
  const reduce = useMedia("(prefers-reduced-motion: reduce)");
  const [len, setLen] = useState(0);
  const prev = useRef("");
  useEffect(() => {
    let k = 0;
    const p = prev.current;
    while (k < p.length && k < text.length && p[k] === text[k]) k++;
    prev.current = text;
    setLen((l) => Math.min(l, k));
  }, [text]);
  useEffect(() => {
    if (len >= text.length) return;
    const id = setTimeout(() => setLen((l) => Math.min(text.length, l + 2)), speed);
    return () => clearTimeout(id);
  }, [len, text, speed]);
  return reduce ? text : text.slice(0, len);
}

function useMetrics(active: boolean) {
  const [m, setM] = useState({
    cpu: 41, mem: 2.3, net: 1.2, lat: 42,
    hist: [22, 31, 44, 38, 52, 47, 36, 58, 49, 41, 63, 55, 44, 39, 51, 46, 60, 52, 41, 48],
  });
  useEffect(() => {
    if (!active) return;
    const id = setInterval(
      () =>
        setM((p) => {
          const cpu = Math.round(28 + Math.random() * 50);
          return {
            cpu,
            mem: +(2.2 + Math.random() * 0.3).toFixed(1),
            net: +(0.6 + Math.random() * 1.8).toFixed(1),
            lat: Math.round(34 + Math.random() * 26),
            hist: [...p.hist.slice(1), cpu],
          };
        }),
      1300,
    );
    return () => clearInterval(id);
  }, [active]);
  return m;
}

function useOutside(ref: React.RefObject<HTMLElement | null>, cb: () => void, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, cb, on]);
}

/* ────────────────────────────────────────────────────────────────────────────
   Small primitives
──────────────────────────────────────────────────────────────────────────── */

const STATUS_STYLE: Record<Status, { dot: string; label: string; text: string }> = {
  running: { dot: "bg-indigo-400", label: "Running", text: "text-indigo-300" },
  finished: { dot: "bg-emerald-400", label: "Finished", text: "text-emerald-300" },
  error: { dot: "bg-rose-400", label: "Error", text: "text-rose-300" },
};

function StatusDot({ status, className }: { status: Status; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span role="img" aria-label={s.label} className={cx("relative inline-flex h-2 w-2 shrink-0", className)}>
      {status === "running" && (
        <span className={cx("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", s.dot)} />
      )}
      <span className={cx("relative inline-flex h-2 w-2 rounded-full", s.dot)} />
    </span>
  );
}

function RoleGlyph({ role, size = 28 }: { role: RoleId; size?: number }) {
  const r = ROLES[role];
  const Icon = r.icon;
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cx("grid shrink-0 place-items-center rounded-lg ring-1 ring-inset", r.bg, r.text, r.ring)}
    >
      <Icon style={{ width: size * 0.52, height: size * 0.52 }} strokeWidth={1.9} />
    </span>
  );
}

function IconBtn({
  label, onClick, children, active, disabled, className,
}: {
  label: string; onClick?: () => void; children: ReactNode; active?: boolean; disabled?: boolean; className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        active && "bg-white/[0.07] text-zinc-100",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
        on ? "border-indigo-400/60 bg-indigo-500" : "border-white/10 bg-white/[0.06]",
      )}
    >
      <span className={cx("absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-[2px] bg-zinc-400")} />
    </button>
  );
}

const Skel = ({ className }: { className?: string }) => <div className={cx("sa-shimmer rounded-md", className)} />;

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="sa-mono rounded border border-white/10 bg-white/[0.04] px-1.5 py-px text-[10px] text-zinc-400">
      {children}
    </kbd>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Dev toolbar
──────────────────────────────────────────────────────────────────────────── */

function DevToolbar({ value, onChange }: { value: Demo; onChange: (d: Demo) => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#0b0b0d] px-3">
      <span className="sa-mono flex shrink-0 items-center gap-1.5 rounded border border-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        <Activity className="h-3 w-3" aria-hidden /> Dev
      </span>
      <div role="group" aria-label="Preview UI state" className="sa-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
        {DEMOS.map((d) => (
          <button
            key={d.id}
            type="button"
            aria-pressed={value === d.id}
            onClick={() => onChange(d.id)}
            className={cx(
              "shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
              value === d.id
                ? "bg-indigo-400/15 text-indigo-200 ring-1 ring-inset ring-indigo-400/30"
                : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200",
            )}
          >
            {d.label}
          </button>
        ))}
      </div>
      <span className="sa-mono hidden shrink-0 text-[11px] text-zinc-600 md:block">swarmagents.codes · UI states</span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Left rail: threads
──────────────────────────────────────────────────────────────────────────── */

function ThreadRail({
  threads, selectedId, onSelect, onNew, collapsed, onToggle, loading, onClose, mobile,
}: {
  threads: Thread[]; selectedId: string | null; onSelect: (t: Thread) => void; onNew: () => void;
  collapsed: boolean; onToggle: () => void; loading: boolean; onClose: () => void; mobile: boolean;
}) {
  const [q, setQ] = useState("");
  const filtered = threads.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()) || ROLES[t.role].name.toLowerCase().includes(q.toLowerCase()));
  const groups = (["Today", "Yesterday", "Older"] as const)
    .map((g) => ({ g, items: filtered.filter((t) => t.group === g) }))
    .filter((x) => x.items.length);

  const brand = (
    <div className="flex items-center gap-2.5">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-400/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
        <Hexagon className="h-4 w-4" strokeWidth={2} />
      </span>
      {!collapsed && <span className="text-[14px] font-semibold tracking-tight text-zinc-100">SwarmAgents</span>}
    </div>
  );

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-2 py-3">
        {brand}
        <IconBtn label="Expand thread list (Ctrl+\)" onClick={onToggle}><PanelLeftOpen className="h-4 w-4" /></IconBtn>
        <IconBtn label="New task" onClick={onNew}><Plus className="h-4 w-4" /></IconBtn>
        <div className="sa-scroll mt-1 flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto border-t border-white/[0.06] pt-3">
          {threads.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t)}
              aria-label={`${t.title}, ${STATUS_STYLE[t.status].label}, ${money(t.cost)}`}
              title={t.title}
              aria-current={t.id === selectedId}
              className={cx("relative rounded-lg p-1", t.id === selectedId && "bg-white/[0.07]")}
            >
              <RoleGlyph role={t.role} size={28} />
              <StatusDot status={t.status} className="absolute -right-0.5 -top-0.5 rounded-full ring-2 ring-[#0c0c0e]" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        {brand}
        {mobile ? (
          <IconBtn label="Close thread list" onClick={onClose}><X className="h-4 w-4" /></IconBtn>
        ) : (
          <IconBtn label="Collapse thread list (Ctrl+\)" onClick={onToggle}><PanelLeftClose className="h-4 w-4" /></IconBtn>
        )}
      </div>

      <div className="space-y-2 px-3 pb-3">
        <button
          type="button"
          onClick={onNew}
          className="flex h-9 w-full items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 text-[13px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
        >
          <span className="flex items-center gap-2"><Plus className="h-4 w-4 text-indigo-300" aria-hidden /> New task</span>
          <Kbd>⌘ N</Kbd>
        </button>
        <label className="relative block">
          <span className="sr-only">Search threads</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search threads"
            className="h-9 w-full rounded-lg border border-white/[0.07] bg-transparent pl-8 pr-8 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-400/50"
          />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-zinc-500 hover:text-zinc-200">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      </div>

      <nav aria-label="Threads" className="sa-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="space-y-3 px-1 pt-1" aria-busy="true" aria-label="Loading threads">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skel className="h-7 w-7 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2"><Skel className="h-3 w-4/5" /><Skel className="h-2.5 w-1/2" /></div>
              </div>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Search className="mx-auto h-5 w-5 text-zinc-600" aria-hidden />
            <p className="mt-3 text-[13px] text-zinc-300">No threads match “{q}”</p>
            <p className="mt-1 text-[12px] text-zinc-500">Try a title or a role like “Builder”.</p>
          </div>
        ) : (
          groups.map(({ g, items }) => (
            <section key={g} className="mb-3">
              <h3 className="px-2 pb-1.5 pt-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">{g}</h3>
              <ul className="space-y-0.5">
                {items.map((t) => {
                  const sel = t.id === selectedId;
                  const st = STATUS_STYLE[t.status];
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(t)}
                        aria-current={sel ? "true" : undefined}
                        className={cx(
                          "group relative flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                          sel ? "bg-white/[0.06]" : "hover:bg-white/[0.035]",
                        )}
                      >
                        {sel && <span className="absolute -left-2 top-2.5 h-5 w-[3px] rounded-r bg-indigo-400" aria-hidden />}
                        <RoleGlyph role={t.role} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className={cx("truncate text-[13px] font-medium", sel ? "text-zinc-50" : "text-zinc-300")}>{t.title}</span>
                            <span className="sa-mono shrink-0 text-[11px] tabular-nums text-zinc-500">{money(t.cost)}</span>
                          </span>
                          <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-zinc-500">
                            <StatusDot status={t.status} />
                            <span className={st.text}>{st.label}</span>
                            <span aria-hidden>·</span>
                            <span>{ROLES[t.role].name}</span>
                            <span aria-hidden>·</span>
                            <span>{t.time}</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] p-3">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-zinc-600 to-zinc-800 text-[11px] font-semibold text-zinc-100">MK</span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-medium text-zinc-200">Maya Kim</p>
          <p className="truncate text-[11.5px] text-zinc-500">acme · Free plan</p>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   The agent's computer: mock desktop
──────────────────────────────────────────────────────────────────────────── */

type TL = { k: "cmd" | "out" | "ok" | "run" | "fail" | "dim" | "warn" | "gap"; t: string };

function testBlock(n: number, mode: "live" | "done" | "fail"): TL[] {
  const L: TL[] = [
    { k: "cmd", t: "npm test" },
    { k: "dim", t: "> app@2.4.1 test" },
    { k: "dim", t: "> vitest run" },
    { k: "gap", t: "" },
  ];
  let before = 0;
  TEST_FILES.forEach((file, i) => {
    const upto = before + file.count;
    if (mode === "done") L.push({ k: "ok", t: ` ✓ ${file.name} (${file.count})` });
    else if (mode === "fail")
      L.push(i === 3 ? { k: "fail", t: ` ✗ ${file.name} (3 failed | 8 passed)` } : { k: "ok", t: ` ✓ ${file.name} (${file.count})` });
    else if (n >= upto) L.push({ k: "ok", t: ` ✓ ${file.name} (${file.count})` });
    else if (n > before) L.push({ k: "run", t: ` ❯ ${file.name} (${n - before}/${file.count})` });
    else L.push({ k: "dim", t: ` ○ ${file.name}` });
    before = upto;
  });
  return L;
}

function termLines(scene: Scene, n: number, control: boolean): TL[] {
  switch (scene) {
    case "approval":
      return [
        { k: "cmd", t: "npx playwright install chromium" },
        { k: "out", t: "Downloading Chromium 131.0.6778.33 (playwright build v1148)…" },
        { k: "fail", t: "Error: ENOSPC: no space left on device, write" },
        { k: "cmd", t: "df -h /" },
        { k: "out", t: "Filesystem      Size  Used Avail Use% Mounted on" },
        { k: "out", t: "/dev/vda1        40G   38G  2.1G  94% /" },
        { k: "cmd", t: "docker system prune -af --volumes" },
        { k: "warn", t: "⏸ Waiting for approval from you…" },
      ];
    case "finished":
      return [
        ...testBlock(52, "done"),
        { k: "gap", t: "" },
        { k: "out", t: " Test Files  5 passed (5)" },
        { k: "ok", t: "      Tests  52 passed (52)" },
        { k: "dim", t: "   Duration  6.81s" },
        { k: "cmd", t: "gh pr create --fill --base main" },
        { k: "ok", t: "https://github.com/acme/storefront/pull/491" },
      ];
    case "error":
      return [
        ...testBlock(49, "fail"),
        { k: "gap", t: "" },
        { k: "fail", t: " FAIL  payment.test.ts > retries card when 3DS challenge times out" },
        { k: "fail", t: " AssertionError: expected 'pending' to be 'succeeded'" },
        { k: "dim", t: "  ❯ src/checkout/payment.test.ts:88:31" },
        { k: "gap", t: "" },
        { k: "out", t: "      Tests  3 failed | 49 passed (52)" },
        { k: "fail", t: "npm ERR! Test failed. exit code 1" },
      ];
    default: {
      const pct = Math.round((n / TOTAL_TESTS) * 100);
      const bar = "█".repeat(Math.round((n / TOTAL_TESTS) * 28)).padEnd(28, "░");
      return [
        { k: "cmd", t: "git pull --rebase origin main" },
        { k: "out", t: "Already up to date." },
        ...testBlock(n, "live"),
        { k: "gap", t: "" },
        { k: "out", t: `      Tests  ${n} passed (${TOTAL_TESTS})` },
        { k: "dim", t: `   ${bar} ${pct}%` },
        ...(control ? [{ k: "warn", t: "⏸ agent paused · process suspended · you have the keyboard" } as TL] : []),
      ];
    }
  }
}

function runUserCommand(cmd: string): TL[] {
  const c = cmd.trim();
  const out: TL[] = [{ k: "cmd", t: c }];
  if (!c) return out;
  const [bin, ...args] = c.split(/\s+/);
  switch (bin) {
    case "ls": out.push({ k: "out", t: "node_modules  package.json  playwright.config.ts  src  vitest.config.ts" }); break;
    case "pwd": out.push({ k: "out", t: "/workspace/app" }); break;
    case "whoami": out.push({ k: "out", t: "agent" }); break;
    case "echo": out.push({ k: "out", t: args.join(" ") }); break;
    case "df": out.push({ k: "out", t: "/dev/vda1        40G   38G  2.1G  94% /" }); break;
    case "git":
      if (args[0] === "status") {
        out.push({ k: "out", t: "On branch fix/flaky-checkout" }, { k: "warn", t: "  modified:   src/checkout/useCart.test.ts" }, { k: "warn", t: "  modified:   src/checkout/useCart.ts" }, { k: "ok", t: "  new file:   src/checkout/waitForCart.ts" });
      } else out.push({ k: "out", t: "(demo shell) only `git status` is simulated" });
      break;
    default: out.push({ k: "fail", t: `bash: ${bin}: command not found` });
  }
  return out;
}

const TERM_COLOR: Record<TL["k"], string> = {
  cmd: "text-zinc-100", out: "text-zinc-300", ok: "text-emerald-400", run: "text-sky-300",
  fail: "text-rose-400", dim: "text-zinc-500", warn: "text-amber-300", gap: "",
};

function Prompt() {
  return (
    <span className="select-none">
      <span className="text-emerald-400">agent@swarm-7f3a</span>
      <span className="text-zinc-500">:</span>
      <span className="text-sky-400">/workspace/app</span>
      <span className="text-zinc-500">$ </span>
    </span>
  );
}

function ScaledStage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1280));
    ro.observe(el);
    setScale(el.clientWidth / 1280);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      <div style={{ width: 1280, height: 800, transform: `scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
    </div>
  );
}

function DesktopMock({
  scene, n, control, paused,
}: { scene: Scene; n: number; control: boolean; paused: boolean }) {
  const [userLines, setUserLines] = useState<TL[]>([]);
  const [cmd, setCmd] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const base = termLines(scene, n, control);
  const lines = control ? [...base, ...userLines] : base;
  const idle = scene === "finished" || scene === "error";
  const showPrompt = control || idle;

  useEffect(() => {
    if (control) inputRef.current?.focus({ preventScroll: true });
  }, [control]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 1e6 });
  }, [lines.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (cmd.trim() === "clear") setUserLines([]);
    else setUserLines((u) => [...u, ...runUserCommand(cmd)]);
    setCmd("");
  };

  return (
    <div
      className="relative h-full w-full select-none overflow-hidden text-zinc-200"
      style={{ background: "radial-gradient(1200px 700px at 20% 10%, #2b2f5c 0%, transparent 60%), radial-gradient(900px 600px at 90% 90%, #123a3f 0%, transparent 55%), #0d0f1a" }}
    >
      {/* top panel */}
      <div className="absolute inset-x-0 top-0 flex h-7 items-center justify-between bg-black/50 px-4 text-[12px] text-zinc-300 backdrop-blur">
        <div className="flex items-center gap-4"><span className="font-semibold">Activities</span><span className="text-zinc-400">Terminal</span></div>
        <span>Tue 14:32</span>
        <div className="flex items-center gap-3 text-zinc-400"><Activity className="h-3.5 w-3.5" /><Globe className="h-3.5 w-3.5" /><span>swarm-7f3a</span></div>
      </div>
      {/* dock */}
      <div className="absolute bottom-6 left-3 top-12 flex w-14 flex-col items-center gap-3 rounded-2xl bg-black/35 py-3 backdrop-blur">
        {[
          [FolderOpen, "bg-sky-500/80"], [TerminalIcon, "bg-zinc-700"], [Globe, "bg-indigo-500/80"], [FilePen, "bg-amber-500/80"], [GitBranch, "bg-rose-500/70"],
        ].map(([Icon, bg], i) => {
          const I = Icon as LucideIcon;
          return <span key={i} className={cx("grid h-10 w-10 place-items-center rounded-xl text-white", bg as string)}><I className="h-5 w-5" /></span>;
        })}
      </div>

      {/* browser window */}
      <div className="absolute overflow-hidden rounded-xl border border-white/10 bg-[#f6f6f4] shadow-2xl shadow-black/60" style={{ left: 92, top: 52, width: 700, height: 520 }}>
        <div className="flex h-9 items-end gap-1 bg-[#dedcd8] px-3">
          <span className="mb-2.5 mr-2 flex gap-1.5"><i className="h-3 w-3 rounded-full bg-[#ff5f57]" /><i className="h-3 w-3 rounded-full bg-[#febc2e]" /><i className="h-3 w-3 rounded-full bg-[#28c840]" /></span>
          <div className="flex h-7 w-52 items-center gap-2 rounded-t-lg bg-[#f6f6f4] px-3 text-[12px] text-zinc-700"><span className="h-3 w-3 rounded bg-indigo-500" />Checkout · Acme Storefront</div>
          <div className="flex h-6 w-40 items-center gap-2 px-3 text-[12px] text-zinc-500"><span className="h-3 w-3 rounded bg-emerald-500" />Test retries | Playwright</div>
        </div>
        <div className="flex h-9 items-center gap-3 border-b border-zinc-300 bg-[#f6f6f4] px-3 text-zinc-500">
          <ArrowLeft className="h-4 w-4" /><ArrowRight className="h-4 w-4" /><RotateCw className="h-4 w-4" />
          <div className="flex h-6 flex-1 items-center gap-2 rounded-full bg-[#e8e6e2] px-3 text-[12px] text-zinc-700"><Lock className="h-3 w-3" />localhost:5173/checkout</div>
        </div>
        <div className="p-6 text-zinc-800">
          <div className="flex items-center justify-between">
            <div className="text-[18px] font-semibold tracking-tight">Acme Storefront</div>
            <span className="rounded bg-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-900">Test mode</span>
          </div>
          <div className="mt-5 grid grid-cols-5 gap-6">
            <div className="col-span-3 space-y-3">
              <div className="text-[13px] font-semibold">Shipping details</div>
              {["Maya Kim", "412 Alder Street, Portland, OR 97205", "maya@acme.dev"].map((v) => (
                <div key={v} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[13px]">{v}</div>
              ))}
              <div className="pt-2 text-[13px] font-semibold">Payment</div>
              <div className="flex items-center justify-between rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-[13px]"><span>4242 4242 4242 4242</span><span className="text-zinc-400">12 / 29</span></div>
            </div>
            <div className="col-span-2 rounded-lg border border-zinc-300 bg-white p-4 text-[13px]">
              <div className="font-semibold">Order summary</div>
              <div className="mt-3 flex justify-between"><span>Merino crew sock × 2</span><span>$24.00</span></div>
              <div className="mt-2 flex justify-between"><span>Trail cap</span><span>$32.00</span></div>
              <div className="mt-3 flex justify-between border-t border-zinc-200 pt-3 font-semibold"><span>Total</span><span>$56.00</span></div>
              <div className="mt-4 rounded-md bg-indigo-600 py-2 text-center font-medium text-white">Pay $56.00</div>
            </div>
          </div>
        </div>
      </div>

      {/* terminal window */}
      <div className="absolute flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0b0c10] shadow-2xl shadow-black/70" style={{ left: 380, top: 300, width: 870, height: 470 }}>
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#15161c] px-3">
          <span className="flex gap-1.5"><i className="h-3 w-3 rounded-full bg-[#ff5f57]" /><i className="h-3 w-3 rounded-full bg-[#febc2e]" /><i className="h-3 w-3 rounded-full bg-[#28c840]" /></span>
          <span className="sa-mono flex-1 text-center text-[12px] text-zinc-400">agent@swarm-7f3a: /workspace/app</span>
          <span className="w-12" />
        </div>
        <div ref={bodyRef} className="sa-mono flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-4 py-3 text-[14px] leading-[22px]">
          {lines.map((l, i) =>
            l.k === "gap" ? (
              <div key={i} className="h-[22px]" />
            ) : (
              <div key={i} className={cx("whitespace-pre", TERM_COLOR[l.k])}>
                {l.k === "cmd" && <Prompt />}
                {l.t}
              </div>
            ),
          )}
          {showPrompt && (
            <form onSubmit={submit} className="flex items-center whitespace-pre">
              <Prompt />
              {control ? (
                <input
                  ref={inputRef}
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  aria-label="Terminal input. You are in control of the agent's computer."
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-zinc-100 caret-indigo-300"
                />
              ) : (
                <span className="sa-caret" />
              )}
            </form>
          )}
        </div>
      </div>

      {/* agent cursor */}
      {(scene === "running" || scene === "approval") && !control && (
        <div className={cx("pointer-events-none absolute left-0 top-0", !paused && "sa-cursor")} style={{ transform: "translate(560px,420px)" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="#818cf8" stroke="#0b0b0f" strokeWidth="1.5"><path d="M4 3l16 7-7 2-2 7z" /></svg>
          <span className="ml-4 -mt-1 inline-block rounded-md bg-indigo-500 px-2 py-0.5 text-[11px] font-medium text-white shadow-lg">Builder agent</span>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Screen frame (hero)
──────────────────────────────────────────────────────────────────────────── */

function BootOverlay() {
  const steps = ["Allocating VM · 2 vCPU · 4 GB", "Restoring /workspace snapshot · 2.1 GB", "Starting desktop session · Xfce 4.18", "Connecting live stream"];
  const [i, setI] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setI((x) => Math.min(steps.length - 1, x + 1)), 900);
    return () => clearInterval(id);
  }, [steps.length]);
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#09090c]" role="status" aria-live="polite" aria-label="Booting the agent's computer">
      <div className="absolute inset-0 opacity-70">
        <Skel className="absolute left-[7%] top-[10%] h-[52%] w-[54%] rounded-xl" />
        <Skel className="absolute left-[30%] top-[40%] h-[50%] w-[64%] rounded-xl" />
      </div>
      <div className="relative w-[min(86%,340px)] rounded-xl border border-white/10 bg-[#0e0e12]/95 p-4 shadow-2xl backdrop-blur sm:p-5">
        <div className="flex items-center gap-2.5 text-[13px] font-medium text-zinc-100"><Loader2 className="h-4 w-4 animate-spin text-indigo-300" aria-hidden />Waking swarm-7f3a…</div>
        <ul className="mt-3 space-y-1.5 sm:mt-4 sm:space-y-2">
          {steps.map((s, k) => (
            <li key={s} className={cx("flex items-center gap-2 text-[11.5px] sm:text-[12px]", k < i ? "text-zinc-300" : k === i ? "text-zinc-100" : "text-zinc-600")}>
              {k < i ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> : k === i ? <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-300" aria-hidden /> : <span className="h-3.5 w-3.5 rounded-full border border-zinc-700" aria-hidden />}
              {s}
            </li>
          ))}
        </ul>
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="sa-indet h-full w-1/3 rounded-full bg-indigo-400" /></div>
      </div>
    </div>
  );
}

function EmptyOverlay({ onSuggest }: { onSuggest: (s: string) => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#09090c] px-4 text-center">
      <div className="sa-grid absolute inset-0" aria-hidden />
      <div className="relative max-w-md">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/[0.03] text-zinc-400 sm:h-14 sm:w-14"><Monitor className="h-5 w-5 sm:h-6 sm:w-6" strokeWidth={1.5} /></span>
        <h2 className="mt-3 text-[15px] font-semibold tracking-tight text-zinc-100 sm:mt-4 sm:text-[18px]">Your agent’s computer is asleep</h2>
        <p className="mt-1.5 hidden text-[13px] leading-relaxed text-zinc-400 sm:block">Everything in <span className="sa-mono text-zinc-300">/workspace</span> persists between tasks. Describe what you need, watch it work live, and take the keyboard whenever you like.</p>
        <p className="mt-1 text-[12px] text-zinc-400 sm:hidden">Describe a task below to boot it.</p>
        <div className="mt-4 hidden flex-wrap justify-center gap-2 sm:flex">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => onSuggest(s)} className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] text-zinc-300 transition-colors hover:border-indigo-400/40 hover:bg-indigo-400/10 hover:text-indigo-100">
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScreenFrame({
  scene, control, paused, n, latency, onControl, onPause, onSuggest,
}: {
  scene: Scene; control: boolean; paused: boolean; n: number; latency: number;
  onControl: (v: boolean) => void; onPause: () => void; onSuggest: (s: string) => void;
}) {
  const [theater, setTheater] = useState(false);
  const live = scene === "running" || scene === "approval" || scene === "finished" || scene === "error";
  const hasSession = live;

  useEffect(() => {
    const h = () => {
      if (!document.fullscreenElement) setTheater(false);
    };
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  useEffect(() => {
    if (!theater) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setTheater(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [theater]);

  const toggleFull = () => {
    if (theater) {
      setTheater(false);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    } else {
      setTheater(true);
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  };

  const pill = (() => {
    if (scene === "loading") return { t: "CONNECTING", c: "text-amber-300", d: "bg-amber-400", ping: true };
    if (scene === "empty") return { t: "OFFLINE", c: "text-zinc-400", d: "bg-zinc-500", ping: false };
    if (control) return { t: `YOU · ${latency} ms`, c: "text-indigo-200", d: "bg-indigo-400", ping: true };
    if (scene === "error") return { t: "ERROR", c: "text-rose-300", d: "bg-rose-400", ping: false };
    if (scene === "finished") return { t: "IDLE", c: "text-emerald-300", d: "bg-emerald-400", ping: false };
    if (scene === "approval") return { t: "WAITING", c: "text-amber-300", d: "bg-amber-400", ping: true };
    if (paused) return { t: "PAUSED", c: "text-zinc-300", d: "bg-zinc-400", ping: false };
    return { t: `LIVE · ${latency} ms`, c: "text-emerald-300", d: "bg-emerald-400", ping: true };
  })();

  const frameTone = control
    ? "border-indigo-400/70 shadow-[0_0_0_1px_rgba(129,140,248,.35),0_0_70px_-12px_rgba(99,102,241,.55)]"
    : scene === "error"
      ? "border-rose-400/30 shadow-[0_20px_60px_-20px_rgba(0,0,0,.8)]"
      : scene === "approval"
        ? "border-amber-400/30 shadow-[0_20px_60px_-20px_rgba(0,0,0,.8)]"
        : "border-white/10 shadow-[0_20px_60px_-20px_rgba(0,0,0,.8)]";

  return (
    <div className={cx(theater ? "fixed inset-0 z-[70] grid place-items-center bg-black" : "relative")}>
      <div
        className={cx("overflow-hidden border bg-black transition-[border-color,box-shadow] duration-300", theater ? "rounded-none" : "rounded-2xl", frameTone)}
        style={theater ? { width: `min(100vw, calc((100vh - ${control ? 44 : 0}px) * 1.6))` } : undefined}
      >
        {control && (
          <div role="status" className="sa-in flex min-h-10 items-center justify-between gap-3 bg-indigo-500 px-3 py-1.5 text-white sm:px-4">
            <p className="flex items-center gap-2 text-[12.5px] font-medium sm:text-[13px]">
              <Hand className="h-4 w-4 shrink-0" aria-hidden />
              <span>You’re in control. <span className="font-normal text-indigo-100">The agent is paused.</span></span>
            </p>
            <button type="button" onClick={() => onControl(false)} className="shrink-0 rounded-md bg-white/15 px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-white/25">
              Hand back <span className="hidden sm:inline">to agent</span>
            </button>
          </div>
        )}

        <div className="relative aspect-[16/10] w-full bg-[#09090c]">
          {hasSession && (
            <ScaledStage>
              <DesktopMock scene={scene} n={n} control={control} paused={paused} />
            </ScaledStage>
          )}
          {scene === "loading" && <BootOverlay />}
          {scene === "empty" && <EmptyOverlay onSuggest={onSuggest} />}

          {/* approval dim */}
          {scene === "approval" && !control && <div className="pointer-events-none absolute inset-0 bg-amber-950/20" />}

          {/* top overlay controls */}
          <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2 sm:inset-x-3 sm:top-3">
            <div className={cx("pointer-events-auto flex items-center gap-2 rounded-full border border-white/10 bg-black/60 py-1 pl-2.5 pr-3 backdrop-blur-md", pill.c)} role="status" aria-label={`Stream status: ${pill.t}`}>
              <span className="relative inline-flex h-2 w-2">
                {pill.ping && <span className={cx("absolute inline-flex h-full w-full animate-ping rounded-full opacity-70", pill.d)} />}
                <span className={cx("relative inline-flex h-2 w-2 rounded-full", pill.d)} />
              </span>
              <span className="sa-mono whitespace-nowrap text-[10.5px] font-semibold tracking-wider sm:text-[11px]">{pill.t}</span>
            </div>

            <div className="pointer-events-auto flex items-center gap-1.5">
              <div role="group" aria-label="Interaction mode" className="flex rounded-lg border border-white/10 bg-black/60 p-0.5 backdrop-blur-md">
                <button type="button" aria-label="View only" aria-pressed={!control} disabled={!hasSession} onClick={() => onControl(false)} className={cx("flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-medium transition-colors disabled:opacity-40 sm:px-2.5", !control ? "bg-white/[0.12] text-white" : "text-zinc-400 hover:text-zinc-100")}>
                  <Eye className="h-3.5 w-3.5" aria-hidden /><span className="hidden sm:inline">View only</span>
                </button>
                <button type="button" aria-pressed={control} disabled={!hasSession} onClick={() => onControl(true)} className={cx("flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-medium transition-colors disabled:opacity-40 sm:px-2.5", control ? "bg-indigo-500 text-white" : "text-zinc-400 hover:text-zinc-100")}>
                  <Hand className="h-3.5 w-3.5" aria-hidden />Take over
                </button>
              </div>
              <button
                type="button"
                aria-label={paused || control ? "Resume agent" : "Pause agent"}
                title={control ? "Agent is paused while you're in control" : paused ? "Resume agent" : "Pause agent"}
                aria-pressed={paused || control}
                disabled={!(scene === "running") || control}
                onClick={onPause}
                className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-black/60 text-zinc-200 backdrop-blur-md transition-colors hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-black/60"
              >
                {paused || control ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                aria-label={theater ? "Exit fullscreen" : "Fullscreen"}
                title={theater ? "Exit fullscreen (Esc)" : "Fullscreen"}
                onClick={toggleFull}
                className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-black/60 text-zinc-200 backdrop-blur-md transition-colors hover:bg-white/10"
              >
                {theater ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {scene === "finished" && !control && (
            <div className="sa-in absolute bottom-3 right-3 flex items-center gap-2 rounded-full border border-emerald-400/25 bg-black/70 px-3 py-1.5 text-[11.5px] text-emerald-200 backdrop-blur-md">
              <Check className="h-3.5 w-3.5" aria-hidden />Task complete · snapshot saved
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Approval card + telemetry strip
──────────────────────────────────────────────────────────────────────────── */

function ApprovalCard({ onDecide }: { onDecide: (k: "approve" | "deny" | "always") => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby="appr-title"
      aria-describedby="appr-why"
      className="sa-in rounded-xl border border-amber-400/30 bg-amber-400/[0.04] p-4 outline-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-amber-400/15 text-amber-300"><ShieldAlert className="h-4 w-4" aria-hidden /></span>
          <h3 id="appr-title" className="text-[14px] font-semibold text-zinc-50">Approval needed</h3>
        </div>
        <div className="flex items-center gap-2" aria-label="Risk level: high">
          <span className="flex gap-0.5" aria-hidden>
            <i className="h-1.5 w-4 rounded-full bg-rose-400" /><i className="h-1.5 w-4 rounded-full bg-rose-400" /><i className="h-1.5 w-4 rounded-full bg-rose-400" />
          </span>
          <span className="sa-mono rounded border border-rose-400/30 bg-rose-400/10 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-rose-300">High risk</span>
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/50">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5 text-[11px] text-zinc-500">
          <span>Command · runs in <span className="sa-mono text-zinc-400">/workspace/app</span></span>
        </div>
        <pre className="sa-mono sa-scroll overflow-x-auto px-3 py-2.5 text-[13px] text-zinc-100"><span className="select-none text-zinc-600">$ </span>docker system prune -af --volumes</pre>
      </div>

      <dl className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed">
        <div className="flex gap-2"><dt className="w-14 shrink-0 text-zinc-500">Why</dt><dd id="appr-why" className="text-zinc-300">Disk is 94% full, so <span className="sa-mono text-[12px] text-zinc-200">playwright install</span> failed with ENOSPC. Reclaiming ~6 GB lets the E2E run continue.</dd></div>
        <div className="flex gap-2"><dt className="w-14 shrink-0 text-zinc-500">Impact</dt><dd className="text-zinc-300">Removes 14 unused images, 3 stopped containers and <span className="text-rose-300">2 unused volumes (incl. pg-data-dev)</span>. Not reversible.</dd></div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onDecide("approve")} className="flex h-9 items-center gap-2 rounded-lg bg-indigo-500 px-4 text-[13px] font-medium text-white transition-colors hover:bg-indigo-400"><Check className="h-4 w-4" aria-hidden />Approve</button>
        <button type="button" onClick={() => onDecide("deny")} className="flex h-9 items-center gap-2 rounded-lg border border-white/15 px-4 text-[13px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.06]"><X className="h-4 w-4" aria-hidden />Deny</button>
        <button type="button" onClick={() => onDecide("always")} className="flex h-9 items-center gap-2 rounded-lg px-3 text-[12.5px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-100"><ShieldCheck className="h-4 w-4" aria-hidden />Always allow for this run</button>
      </div>
    </div>
  );
}

const TOOL_ICON: Record<ToolKind, LucideIcon> = {
  terminal: TerminalIcon, browser: Globe, edit: FilePen, read: FileText, search: Search, git: GitBranch, shield: ShieldCheck, user: User,
};

function StepStatusIcon({ s }: { s: StepStatus }) {
  switch (s) {
    case "done": return <Check className="h-3.5 w-3.5 text-emerald-400" aria-label="Done" />;
    case "running": return <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-300" aria-label="Running" />;
    case "error": return <X className="h-3.5 w-3.5 text-rose-400" aria-label="Failed" />;
    case "waiting": return <ShieldAlert className="h-3.5 w-3.5 text-amber-300" aria-label="Waiting for approval" />;
    case "paused": return <Pause className="h-3.5 w-3.5 text-zinc-400" aria-label="Paused" />;
  }
}

function Spark({ data }: { data: number[] }) {
  return (
    <svg width="48" height="16" viewBox="0 0 48 16" aria-hidden className="text-indigo-300/80">
      {data.map((v, i) => (
        <rect key={i} x={i * 2.4} y={16 - (v / 100) * 16} width="1.6" height={(v / 100) * 16} rx=".5" fill="currentColor" opacity={0.35 + (i / data.length) * 0.65} />
      ))}
    </svg>
  );
}

function Telemetry({
  scene, control, paused, stopped, n, elapsed, steps, metrics, onDecide, onAction,
}: {
  scene: Scene; control: boolean; paused: boolean; stopped: boolean; n: number; elapsed: number; steps: Step[];
  metrics: ReturnType<typeof useMetrics>; onDecide: (k: "approve" | "deny" | "always") => void; onAction: (a: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = scene === "running" && !paused && !control;

  const narration = (() => {
    if (scene === "loading") return "Booting desktop… restoring /workspace snapshot";
    if (scene === "empty") return "Idle. Send a task to wake the computer.";
    if (control) return "You’re driving. Agent paused at step 6 and will resume when you hand back.";
    if (scene === "approval") return "Waiting for your approval: docker system prune -af --volumes";
    if (scene === "finished") return stopped ? "Stopped by you at step 6. Workspace and snapshot preserved." : "Finished in 04:12. 52/52 tests passed · PR #491 opened";
    if (scene === "error") return "Command failed: npm test exited with code 1. 3 tests failed in payment.test.ts";
    if (paused) return `Paused by you. npm test suspended at ${n}/${TOTAL_TESTS}`;
    return `Running npm test in /workspace/app… ${n}/${TOTAL_TESTS} passed`;
  })();
  const typed = useTypewriter(narration);
  const streaming = typed.length < narration.length;

  const tone = scene === "error" ? "text-rose-300" : scene === "approval" ? "text-amber-200" : scene === "finished" ? "text-emerald-200" : "text-zinc-100";
  const Lead = scene === "loading" ? Loader2 : scene === "error" ? TriangleAlert : scene === "finished" ? Check : scene === "approval" ? ShieldAlert : control ? Hand : paused ? Pause : scene === "empty" ? Monitor : Loader2;
  const leadColor = scene === "error" ? "text-rose-400" : scene === "finished" ? "text-emerald-400" : scene === "approval" ? "text-amber-300" : control || paused || scene === "empty" ? "text-zinc-400" : "text-indigo-300";
  const spin = (scene === "running" && live) || scene === "loading";

  const actions: { id: string; label: string; primary?: boolean }[] =
    scene === "error" ? [{ id: "retry", label: "Retry step", primary: true }, { id: "fix", label: "Ask agent to fix" }]
      : scene === "finished" ? [{ id: "pr", label: "View PR #491", primary: true }, { id: "follow", label: "Follow up" }]
        : control ? [{ id: "handback", label: "Hand back", primary: true }]
          : paused && scene === "running" ? [{ id: "resume", label: "Resume", primary: true }] : [];

  return (
    <section aria-label="Agent telemetry" className="space-y-3">
      {scene === "approval" && !control ? (
        <ApprovalCard onDecide={onDecide} />
      ) : (
        <div className="rounded-xl border border-white/[0.08] bg-[#0e0e11]">
          <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
            <Lead className={cx("mt-[3px] h-4 w-4 shrink-0", leadColor, spin && "animate-spin")} aria-hidden />
            <p
              aria-live="polite"
              aria-atomic="false"
              className={cx("sa-mono min-w-0 flex-1 break-words text-[12.5px] leading-[1.55] sm:truncate sm:text-[13px]", tone, streaming && "sa-caret")}
              title={narration}
            >
              {scene === "loading" ? <span className="sa-caret">{typed}</span> : typed}
            </p>
            {actions.length > 0 && (
              <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                {actions.map((a) => (
                  <button key={a.id} type="button" onClick={() => onAction(a.id)} className={cx("h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors", a.primary ? "bg-white/[0.09] text-zinc-100 hover:bg-white/[0.14]" : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100")}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="h-px w-full overflow-hidden bg-white/[0.06]" aria-hidden>
            {live && <div className="sa-indet h-full w-1/4 bg-indigo-400/80" />}
            {scene === "finished" && <div className="h-full w-full bg-emerald-400/60" />}
            {scene === "error" && <div className="h-full w-full bg-rose-400/60" />}
          </div>

          {actions.length > 0 && (
            <div className="flex gap-1.5 px-4 pt-3 sm:hidden">
              {actions.map((a) => (
                <button key={a.id} type="button" onClick={() => onAction(a.id)} className={cx("h-8 rounded-md px-3 text-[12px] font-medium", a.primary ? "bg-white/[0.09] text-zinc-100" : "border border-white/10 text-zinc-300")}>{a.label}</button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="sa-mono flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
              <span className="tabular-nums text-zinc-300">{scene === "empty" || scene === "loading" ? "--:--" : mmss(elapsed)}</span>
              <span className="tabular-nums">Step {steps.length ? steps.length : "–"}</span>
              <span className="hidden items-center gap-1.5 sm:flex"><Cpu className="h-3 w-3" aria-hidden />CPU <span className="tabular-nums text-zinc-300">{scene === "empty" || scene === "loading" ? "–" : `${metrics.cpu}%`}</span><Spark data={metrics.hist} /></span>
              <span className="hidden tabular-nums md:block">MEM <span className="text-zinc-300">{scene === "empty" || scene === "loading" ? "–" : `${metrics.mem} GB`}</span></span>
              <span className="hidden tabular-nums md:block">NET <span className="text-zinc-300">{scene === "empty" || scene === "loading" ? "–" : `↓ ${metrics.net} MB/s`}</span></span>
            </div>
            <button
              type="button"
              aria-expanded={open}
              aria-controls="step-history"
              onClick={() => setOpen((o) => !o)}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
            >
              Steps <span className="sa-mono text-zinc-500">{steps.length}</span>
              {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
            </button>
          </div>
        </div>
      )}

      {/* step history (always available, even during approval) */}
      {(open || (scene === "approval" && !control && open)) && (
        <StepList id="step-history" steps={steps} loading={scene === "loading"} />
      )}
      {scene === "approval" && !control && !open && (
        <button type="button" aria-expanded={false} aria-controls="step-history" onClick={() => setOpen(true)} className="flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />Step history <span className="sa-mono text-zinc-500">{steps.length}</span>
        </button>
      )}
    </section>
  );
}

function StepList({ id, steps, loading }: { id: string; steps: Step[]; loading: boolean }) {
  return (
    <div id={id} className="sa-in overflow-hidden rounded-xl border border-white/[0.08] bg-[#0e0e11]">
      {loading ? (
        <div className="space-y-3 p-4" aria-busy="true">{Array.from({ length: 3 }).map((_, i) => <Skel key={i} className="h-8 w-full" />)}</div>
      ) : steps.length === 0 ? (
        <p className="px-4 py-6 text-center text-[12.5px] text-zinc-500">No steps yet. Actions the agent takes will appear here, with timing.</p>
      ) : (
        <ol className="sa-scroll max-h-64 divide-y divide-white/[0.05] overflow-y-auto">
          {steps.map((s, i) => {
            const Icon = TOOL_ICON[s.tool];
            return (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="sa-mono w-4 text-[10.5px] tabular-nums text-zinc-600">{i + 1}</span>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/[0.08] bg-white/[0.03] text-zinc-400"><Icon className="h-3.5 w-3.5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <p className="sa-mono truncate text-[12px] text-zinc-200">{s.action}</p>
                  {s.detail && <p className="truncate text-[11.5px] text-zinc-500">{s.detail}</p>}
                </div>
                <span className="sa-mono shrink-0 text-[11px] tabular-nums text-zinc-500">{s.dur}</span>
                <span className="grid w-5 shrink-0 place-items-center"><StepStatusIcon s={s.status} /></span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Composer
──────────────────────────────────────────────────────────────────────────── */

function Composer({
  draft, setDraft, role, setRole, running, disabled, cost, cap, onSend, onStop, scene,
}: {
  draft: string; setDraft: (s: string) => void; role: RoleId; setRole: (r: RoleId) => void; running: boolean;
  disabled: boolean; cost: number; cap: number; onSend: () => void; onStop: () => void; scene: Scene;
}) {
  const [roleOpen, setRoleOpen] = useState(false);
  const [provOpen, setProvOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const roleRef = useRef<HTMLDivElement>(null);
  const provRef = useRef<HTMLDivElement>(null);
  const closeRole = useCallback(() => setRoleOpen(false), []);
  const closeProv = useCallback(() => setProvOpen(false), []);
  useOutside(roleRef, closeRole, roleOpen);
  useOutside(provRef, closeProv, provOpen);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const r = ROLES[role];
  const RIcon = r.icon;
  const pct = Math.min(100, (cost / cap) * 100);
  const placeholder = disabled
    ? "You’re in control. Hand back to message the agent."
    : running
      ? "Steer the agent. Your message is queued after the current step…"
      : scene === "finished" || scene === "error"
        ? "Follow up, or ask the agent to try a different approach…"
        : "Describe a task for your agent’s computer…";

  const roleKeys = Object.keys(ROLES) as RoleId[];
  const onRoleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setRoleOpen(false); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(roleRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div>
      <div className={cx("rounded-2xl border bg-[#101013] transition-colors focus-within:border-indigo-400/50", disabled ? "border-indigo-400/25 opacity-70" : "border-white/10")}>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {files.map((fl) => (
              <span key={fl} className="sa-mono flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] py-1 pl-2 pr-1 text-[11.5px] text-zinc-300">
                <FileText className="h-3 w-3 text-zinc-500" aria-hidden />{fl}
                <button type="button" aria-label={`Remove ${fl}`} onClick={() => setFiles((x) => x.filter((y) => y !== fl))} className="grid h-4 w-4 place-items-center rounded text-zinc-500 hover:text-zinc-100"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
        <label className="block">
          <span className="sr-only">Message the agent</span>
          <textarea
            id="sa-composer"
            ref={taRef}
            rows={1}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={placeholder}
            className="block max-h-40 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-6 text-zinc-100 placeholder:text-zinc-600 disabled:cursor-not-allowed"
          />
        </label>

        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
          {/* role selector */}
          <div className="relative" ref={roleRef} onKeyDown={onRoleKey}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={roleOpen}
              aria-label={`Role: ${r.name}. Change role`}
              onClick={() => setRoleOpen((o) => !o)}
              className={cx("flex h-8 items-center gap-2 rounded-lg border px-2 text-[12.5px] font-medium transition-colors", r.text, r.bg, "border-white/[0.06] hover:border-white/20")}
            >
              <RIcon className="h-3.5 w-3.5" aria-hidden /><span className="hidden sm:inline">{r.name}</span><ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
            </button>
            {roleOpen && (
              <div role="menu" aria-label="Agent role" className="sa-in absolute bottom-full left-0 z-30 mb-2 w-[280px] max-w-[80vw] rounded-xl border border-white/10 bg-[#141418] p-1.5 shadow-2xl shadow-black/60">
                {roleKeys.map((k) => {
                  const rr = ROLES[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      role="menuitemradio"
                      aria-checked={k === role}
                      autoFocus={k === role}
                      onClick={() => { setRole(k); setRoleOpen(false); taRef.current?.focus(); }}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.06]"
                    >
                      <RoleGlyph role={k} size={28} />
                      <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-zinc-100">{rr.name}</span><span className="block truncate text-[11.5px] text-zinc-500">{rr.desc}</span></span>
                      {k === role && <Check className="h-4 w-4 text-indigo-300" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <IconBtn label="Attach files" onClick={() => setFiles((x) => (x.includes("failing-tests.log") ? x : [...x, "failing-tests.log"]))} disabled={disabled}>
            <Paperclip className="h-4 w-4" />
          </IconBtn>

          {/* provider chip */}
          <div className="relative" ref={provRef}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={provOpen}
              aria-label={`Provider: Free, Radium. Session cost ${money(cost)} of ${money(cap)} cap`}
              onClick={() => setProvOpen((o) => !o)}
              className="flex h-8 items-center gap-2 rounded-lg border border-white/[0.07] px-2 text-[12px] text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.03]"
            >
              <Zap className="h-3.5 w-3.5 text-indigo-300" aria-hidden />
              <span className="whitespace-nowrap font-medium">Free · Radium</span>
              <span className="hidden h-1 w-10 overflow-hidden rounded-full bg-white/10 sm:block" aria-hidden><span className={cx("block h-full rounded-full", pct > 80 ? "bg-amber-400" : "bg-indigo-400")} style={{ width: `${pct}%` }} /></span>
              <span className="sa-mono hidden text-[11px] tabular-nums text-zinc-500 min-[440px]:inline">{money(cost)}</span>
            </button>
            {provOpen && (
              <div role="dialog" aria-label="Provider usage" className="sa-in absolute bottom-full left-0 z-30 mb-2 w-[260px] rounded-xl border border-white/10 bg-[#141418] p-3.5 shadow-2xl shadow-black/60 sm:left-auto sm:right-0">
                <div className="flex items-center justify-between text-[12.5px]"><span className="font-medium text-zinc-100">Radium · Free tier</span><span className="rounded bg-indigo-400/10 px-1.5 py-0.5 text-[10.5px] text-indigo-300">Active</span></div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-indigo-400" style={{ width: `${pct}%` }} /></div>
                <div className="sa-mono mt-2 flex justify-between text-[11px] text-zinc-400"><span>{money(cost)} this thread</span><span>cap {money(cap)}</span></div>
                <p className="mt-3 border-t border-white/[0.06] pt-3 text-[11.5px] leading-relaxed text-zinc-500">Free tier covers 120 agent steps a day. At the cap the agent pauses and asks before switching providers.</p>
              </div>
            )}
          </div>

          <span className="flex-1" />

          {running && (
            <button type="button" onClick={onStop} aria-label="Stop agent" className="sa-in flex h-8 items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-400/10 px-2.5 text-[12.5px] font-medium text-rose-200 transition-colors hover:bg-rose-400/20">
              <Square className="h-3 w-3 fill-current" aria-hidden />Stop
            </button>
          )}
          <button
            type="button"
            onClick={onSend}
            disabled={!draft.trim() || disabled}
            aria-label="Send message"
            className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-500 text-white transition-colors hover:bg-indigo-400 disabled:bg-white/[0.06] disabled:text-zinc-600"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="mt-2 hidden items-center gap-x-4 gap-y-1 px-1 text-[11.5px] text-zinc-600 sm:flex">
        <span className="flex items-center gap-1.5"><Kbd><CornerDownLeft className="inline h-2.5 w-2.5" /></Kbd> send</span>
        <span className="flex items-center gap-1.5"><Kbd>⇧ ↵</Kbd> new line</span>
        <span className="flex items-center gap-1.5"><Kbd>Ctrl .</Kbd> stop</span>
        <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd> hand back</span>
      </p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Right drawer
──────────────────────────────────────────────────────────────────────────── */

type Tab = "files" | "browser" | "plan" | "library";
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "files", label: "Files", icon: FolderTree },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "library", label: "Library", icon: Library },
];

function EmptyPane({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="px-6 py-14 text-center">
      <span className="mx-auto grid h-10 w-10 place-items-center rounded-xl border border-white/10 text-zinc-500"><Icon className="h-5 w-5" strokeWidth={1.5} /></span>
      <p className="mt-4 text-[13px] font-medium text-zinc-200">{title}</p>
      <p className="mx-auto mt-1 max-w-[240px] text-[12px] leading-relaxed text-zinc-500">{body}</p>
    </div>
  );
}

function PaneSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {[90, 70, 80, 60, 75, 50].map((w, i) => (
        <div key={i} style={{ width: `${w}%` }}><Skel className="h-6" /></div>
      ))}
    </div>
  );
}

function FileRow({ node, depth, open, toggle, selected, onSelect }: {
  node: FNode; depth: number; open: Set<string>; toggle: (p: string) => void; selected: string; onSelect: (p: string) => void;
}) {
  const isOpen = open.has(node.path);
  const pad = { paddingLeft: 8 + depth * 14 };
  if (node.kind === "dir") {
    const I = isOpen ? FolderOpen : Folder;
    return (
      <>
        <li>
          <button type="button" aria-expanded={isOpen} onClick={() => toggle(node.path)} style={pad} className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] text-zinc-300 hover:bg-white/[0.04]">
            <ChevronRight className={cx("h-3 w-3 shrink-0 text-zinc-500 transition-transform", isOpen && "rotate-90")} aria-hidden />
            <I className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
            <span className="truncate">{node.name}</span>
          </button>
        </li>
        {isOpen && node.children?.map((c) => <FileRow key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} selected={selected} onSelect={onSelect} />)}
      </>
    );
  }
  const sel = selected === node.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        aria-current={sel}
        aria-label={`${node.name}${node.st ? (node.st === "A" ? ", added" : ", modified") : ""}`}
        style={{ paddingLeft: 8 + depth * 14 + 15 }}
        className={cx("flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px]", sel ? "bg-white/[0.08] text-zinc-50" : node.st ? "bg-indigo-400/[0.06] text-zinc-100 hover:bg-indigo-400/10" : "text-zinc-400 hover:bg-white/[0.04]")}
      >
        <FileText className={cx("h-3.5 w-3.5 shrink-0", node.st ? "text-indigo-300" : "text-zinc-600")} aria-hidden />
        <span className="flex-1 truncate">{node.name}</span>
        {node.st && (
          <span className="sa-mono flex shrink-0 items-center gap-1.5 text-[10.5px]">
            <span className="text-emerald-400">+{node.add}</span>{!!node.del && <span className="text-rose-400">−{node.del}</span>}
            <span className={cx("grid h-4 w-4 place-items-center rounded font-semibold", node.st === "A" ? "bg-emerald-400/15 text-emerald-300" : "bg-indigo-400/15 text-indigo-300")}>{node.st}</span>
          </span>
        )}
      </button>
    </li>
  );
}

function FilesPane({ scene }: { scene: Scene }) {
  const [open, setOpen] = useState<Set<string>>(new Set(["app", "app/src", "app/src/checkout"]));
  const [sel, setSel] = useState("app/src/checkout/useCart.test.ts");
  if (scene === "loading") return <PaneSkeleton />;
  if (scene === "empty") return <EmptyPane icon={FolderOpen} title="Workspace is empty" body="Files the agent creates or edits show up here, with a diff for every change." />;
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const diff = DIFFS[sel];
  const name = sel.split("/").pop();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-3 text-[11px] uppercase tracking-wider text-zinc-500">
        <span>/workspace</span>
        <span className="rounded bg-indigo-400/10 px-1.5 py-0.5 normal-case tracking-normal text-indigo-300">5 changed</span>
      </div>
      <ul className="sa-scroll max-h-[44%] shrink-0 overflow-y-auto px-2 pb-2" role="tree" aria-label="Workspace files">
        <FileRow node={TREE} depth={0} open={open} toggle={toggle} selected={sel} onSelect={setSel} />
      </ul>
      <div className="flex min-h-0 flex-1 flex-col border-t border-white/[0.07]">
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="sa-mono truncate text-[12px] text-zinc-300">{name}</span>
          {diff && <span className="sa-mono text-[11px] text-zinc-500">diff</span>}
        </div>
        <div className="sa-scroll sa-mono min-h-0 flex-1 overflow-auto pb-3 text-[11.5px] leading-5">
          {diff ? diff.map((l, i) => (
            <div key={i} className={cx("flex whitespace-pre px-4", l.t === "add" && "bg-emerald-400/[0.09] text-emerald-200", l.t === "del" && "bg-rose-400/[0.09] text-rose-200", l.t === "hunk" && "text-indigo-300/80", l.t === "ctx" && "text-zinc-400")}>
              <span className="w-4 shrink-0 select-none opacity-60">{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>{l.s}
            </div>
          )) : (
            <p className="px-4 py-6 font-sans text-[12px] text-zinc-500">No changes in this file.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BrowserPane({ scene }: { scene: Scene }) {
  const [active, setActive] = useState("b1");
  if (scene === "loading") return <PaneSkeleton />;
  if (scene === "empty") return <EmptyPane icon={Globe} title="No browser session" body="When the agent opens a page, its tabs and current URL appear here." />;
  const cur = BROWSER_TABS.find((t) => t.id === active)!;
  return (
    <div className="p-4">
      <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 p-1.5">
        <span className="grid h-6 w-6 place-items-center text-zinc-600"><ArrowLeft className="h-3.5 w-3.5" aria-hidden /></span>
        <span className="grid h-6 w-6 place-items-center text-zinc-600"><ArrowRight className="h-3.5 w-3.5" aria-hidden /></span>
        <div className="sa-mono flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-[11.5px] text-zinc-300"><Lock className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden /><span className="truncate">{cur.url}</span></div>
      </div>
      <p className="sa-mono mt-2 px-1 text-[11px] text-zinc-500">{cur.meta}</p>
      <h3 className="mb-2 mt-5 px-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Tabs · {BROWSER_TABS.length}</h3>
      <ul className="space-y-1" role="tablist" aria-label="Agent browser tabs" aria-orientation="vertical">
        {BROWSER_TABS.map((t) => (
          <li key={t.id}>
            <button type="button" role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)} className={cx("flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors", t.id === active ? "border-indigo-400/30 bg-indigo-400/[0.07]" : "border-transparent hover:bg-white/[0.04]")}>
              <span className={cx("h-4 w-4 shrink-0 rounded", t.color)} aria-hidden />
              <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-zinc-200">{t.title}</span><span className="sa-mono block truncate text-[11px] text-zinc-500">{t.url}</span></span>
              {t.id === "b1" && <span className="rounded bg-indigo-400/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">Agent</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanPane({ scene, n }: { scene: Scene; n: number }) {
  if (scene === "loading") return <PaneSkeleton />;
  const plan = planFor(scene, n);
  if (!plan.length) return <EmptyPane icon={ListChecks} title="No plan yet" body="The agent writes a short checklist before it starts and ticks it off live." />;
  const done = plan.filter((p) => p.st === "done").length;
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between text-[12px]">
        <span className="text-zinc-400">{done} of {plan.length} complete</span>
        <span className="h-1 w-24 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-indigo-400 transition-all" style={{ width: `${(done / plan.length) * 100}%` }} /></span>
      </div>
      <ol className="relative space-y-1">
        {plan.map((p, i) => (
          <li key={i} className={cx("flex gap-3 rounded-lg px-2 py-2.5", p.st === "active" && "bg-white/[0.04]", p.st === "failed" && "bg-rose-400/[0.06]")}>
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center" aria-label={p.st}>
              {p.st === "done" && <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-400/15 text-emerald-400"><Check className="h-3 w-3" /></span>}
              {p.st === "active" && <Loader2 className="h-4 w-4 animate-spin text-indigo-300" />}
              {p.st === "pending" && <span className="h-4 w-4 rounded-full border border-zinc-700" />}
              {p.st === "failed" && <span className="grid h-5 w-5 place-items-center rounded-full bg-rose-400/15 text-rose-400"><X className="h-3 w-3" /></span>}
            </span>
            <span className="min-w-0">
              <span className={cx("block text-[13px]", p.st === "pending" ? "text-zinc-500" : p.st === "done" ? "text-zinc-300" : "text-zinc-50")}>{p.text}</span>
              {p.sub && <span className={cx("mt-0.5 block text-[11.5px]", p.st === "failed" ? "text-rose-300" : "text-zinc-500")}>{p.sub}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function LibraryPane({ scene }: { scene: Scene }) {
  const [sub, setSub] = useState<LibKey>("connectors");
  const [state, setState] = useState<Record<string, boolean>>(() => {
    const s: Record<string, boolean> = {};
    (Object.keys(LIB) as LibKey[]).forEach((k) => LIB[k].forEach((i) => (s[`${k}:${i.id}`] = i.on)));
    return s;
  });
  const items = LIB[sub];
  const count = items.filter((i) => state[`${sub}:${i.id}`]).length;
  const subs: { id: LibKey; label: string }[] = [
    { id: "connectors", label: "Connectors" }, { id: "mcp", label: "MCP" }, { id: "skills", label: "Skills" }, { id: "tools", label: "Tools" },
  ];
  return (
    <div className="p-4">
      <div role="group" aria-label="Library category" className="grid grid-cols-4 gap-0.5 rounded-lg border border-white/[0.08] bg-black/30 p-0.5">
        {subs.map((s) => (
          <button key={s.id} type="button" aria-pressed={sub === s.id} onClick={() => setSub(s.id)} className={cx("h-7 rounded-md text-[11.5px] font-medium transition-colors", sub === s.id ? "bg-white/[0.1] text-zinc-50" : "text-zinc-500 hover:text-zinc-200")}>{s.label}</button>
        ))}
      </div>
      <div className="mb-2 mt-4 flex items-center justify-between px-1 text-[11px] text-zinc-500"><span className="uppercase tracking-wider">{count} of {items.length} enabled</span>{scene === "running" && <span>Applies to this run</span>}</div>
      <ul className="space-y-1.5">
        {items.map((it) => {
          const k = `${sub}:${it.id}`;
          const Icon = it.icon;
          return (
            <li key={it.id} className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
              <span className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/[0.08]", state[k] ? "bg-indigo-400/10 text-indigo-300" : "bg-white/[0.03] text-zinc-500")}><Icon className="h-4 w-4" aria-hidden /></span>
              <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-zinc-200">{it.name}</span><span className="block truncate text-[11.5px] text-zinc-500">{it.desc}</span></span>
              <Toggle on={state[k]} onChange={(v) => setState((s) => ({ ...s, [k]: v }))} label={`${state[k] ? "Disable" : "Enable"} ${it.name}`} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Drawer({ scene, n, onClose, mobile }: { scene: Scene; n: number; onClose: () => void; mobile: boolean }) {
  const [tab, setTab] = useState<Tab>("files");
  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    if (e.key === "ArrowRight") setTab(TABS[(i + 1) % TABS.length].id);
    else if (e.key === "ArrowLeft") setTab(TABS[(i - 1 + TABS.length) % TABS.length].id);
    else return;
    e.preventDefault();
    requestAnimationFrame(() => document.getElementById(`tab-${TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id}`)?.focus());
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {mobile && <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-white/15" aria-hidden />}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] pl-2 pr-3">
        <div role="tablist" aria-label="Workspace panels" onKeyDown={onKey} className="flex items-center gap-0.5">
          {TABS.map((t) => {
            const I = t.icon;
            const on = tab === t.id;
            return (
              <button key={t.id} id={`tab-${t.id}`} type="button" role="tab" aria-selected={on} aria-controls={`panel-${t.id}`} tabIndex={on ? 0 : -1} onClick={() => setTab(t.id)} className={cx("relative flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors", on ? "text-zinc-50" : "text-zinc-500 hover:text-zinc-200")}>
                <I className="h-3.5 w-3.5" aria-hidden />{t.label}
                {on && <span className="absolute inset-x-2 -bottom-[9px] h-px bg-indigo-400" aria-hidden />}
              </button>
            );
          })}
        </div>
        <IconBtn label="Close panel" onClick={onClose}><X className="h-4 w-4" /></IconBtn>
      </div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="sa-scroll min-h-0 flex-1 overflow-y-auto">
        {tab === "files" && <FilesPane scene={scene} />}
        {tab === "browser" && <BrowserPane scene={scene} />}
        {tab === "plan" && <PlanPane scene={scene} n={n} />}
        {tab === "library" && <LibraryPane scene={scene} />}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   App
──────────────────────────────────────────────────────────────────────────── */

// Caps the hero's width so the screen + strip + composer fit a 900px-tall viewport.
const CAP = "lg:max-w-[max(560px,calc((100dvh_-_380px)_*_1.6))]";

export default function App() {
  const isDesktop = useMedia("(min-width: 1024px)");
  const [scene, setScene] = useState<Scene>("running");
  const [control, setControl] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [threads, setThreads] = useState<Thread[]>(THREADS);
  const [selectedId, setSelectedId] = useState<string | null>("t1");
  const [railOpen, setRailOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [mRail, setMRail] = useState(false);
  const [mDrawer, setMDrawer] = useState(false);
  const [role, setRole] = useState<RoleId>("builder");
  const [draft, setDraft] = useState("");
  const [extra, setExtra] = useState<Step[]>([]);
  const [n, setN] = useState(41);
  const [elapsed, setElapsed] = useState(187);
  const [ticks, setTicks] = useState(0);
  const bootTimer = useRef<number | undefined>(undefined);

  const running = scene === "running" || scene === "approval";
  const ticking = scene === "running" && !paused && !control;
  const metrics = useMetrics(scene !== "empty" && scene !== "loading");

  // live progress + clock
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => {
      setElapsed((e) => e + 1);
      setTicks((t) => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [ticking]);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setN((v) => Math.min(51, v + 1)), 2200);
    return () => clearInterval(id);
  }, [ticking]);

  const reset = useCallback((s: Demo) => {
    window.clearTimeout(bootTimer.current);
    setExtra([]);
    setStopped(false);
    setPaused(false);
    setTicks(0);
    setElapsed(DEMO_SEED[s].elapsed);
    setN(DEMO_SEED[s].n);
  }, []);

  const setDemo = useCallback((d: Demo) => {
    reset(d);
    if (d === "takeover") { setScene("running"); setControl(true); } else { setScene(d); setControl(false); }
    setSelectedId((id) => (d === "empty" ? null : id ?? "t1"));
  }, [reset]);

  const demo: Demo = control ? "takeover" : scene;

  const selectThread = (t: Thread) => {
    setSelectedId(t.id);
    setMRail(false);
    const next: Demo = t.status === "running" ? "running" : t.status;
    reset(next);
    setScene(next as Scene);
    setControl(false);
  };

  const newTask = () => {
    setDemo("empty");
    setMRail(false);
    setTimeout(() => document.getElementById("sa-composer")?.focus(), 50);
  };

  const send = () => {
    const text = draft.trim();
    if (!text || control) return;
    setDraft("");
    if (running) {
      setExtra((e) => [...e, { id: uid(), tool: "user", action: "Message queued", detail: text, dur: "—", status: "done" }]);
      return;
    }
    const id = `n${Date.now()}`;
    setThreads((t) => [{ id, title: text.length > 56 ? `${text.slice(0, 54)}…` : text, role, status: "running", cost: 0, group: "Today", time: "now" }, ...t]);
    setSelectedId(id);
    reset("running");
    setElapsed(0);
    setControl(false);
    setScene("loading");
    bootTimer.current = window.setTimeout(() => setScene("running"), 3600);
  };

  const stop = () => {
    setStopped(true);
    setControl(false);
    setScene("finished");
  };

  const decide = (k: "approve" | "deny" | "always") => {
    const cmd = "docker system prune -af --volumes";
    setExtra((e) => [
      ...e,
      {
        id: uid(), tool: "shield",
        action: k === "approve" ? `Approved: ${cmd}` : k === "always" ? `Always allowed for this run: docker system prune *` : `Denied: ${cmd}`,
        detail: k === "deny" ? "Agent will look for a safer way to free space" : "Reclaimed 6.1 GB",
        dur: "—", status: k === "deny" ? "error" : "done",
      },
    ]);
    setScene("running");
  };

  const onAction = (a: string) => {
    if (a === "retry" || a === "fix") { reset("running"); setScene("running"); setControl(false); }
    else if (a === "handback") setControl(false);
    else if (a === "resume") setPaused(false);
    else if (a === "follow") document.getElementById("sa-composer")?.focus();
  };

  const toggleControl = (v: boolean) => {
    setControl(v);
    if (!v) setPaused(false);
  };

  // global shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") { setControl(false); setMRail(false); setMDrawer(false); }
      else if (mod && e.key === ".") { e.preventDefault(); if (running) stop(); }
      else if (mod && e.key === "\\") { e.preventDefault(); setRailOpen((o) => !o); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  useEffect(() => () => window.clearTimeout(bootTimer.current), []);

  const selected = threads.find((t) => t.id === selectedId) ?? null;
  const liveStatus: Status = scene === "finished" ? "finished" : scene === "error" ? "error" : "running";
  const shownThreads = threads.map((t) => (t.id === selectedId && scene !== "empty" ? { ...t, status: liveStatus, cost: t.id === "t1" || t.id.startsWith("n") ? +(t.cost + ticks * 0.0004).toFixed(2) : t.cost } : t));
  const sel = shownThreads.find((t) => t.id === selectedId) ?? null;
  const sessionCost = sel ? sel.cost : 0;
  const steps = [...stepsFor(scene, control, paused), ...extra];
  const title = selected && scene !== "empty" ? selected.title : "New task";

  const railCollapsed = isDesktop && !railOpen;
  const showMobileScrim = !isDesktop && (mRail || mDrawer);

  return (
    <div className="sa-root flex h-dvh flex-col overflow-hidden bg-[#09090b] text-zinc-200">
      <style>{CSS}</style>
      <DevToolbar value={demo} onChange={setDemo} />

      <div className="relative flex min-h-0 flex-1">
        {showMobileScrim && (
          <button type="button" aria-label="Close panel" onClick={() => { setMRail(false); setMDrawer(false); }} className="fixed inset-0 z-30 bg-black/70 backdrop-blur-[2px]" />
        )}

        {/* left rail */}
        <aside
          aria-label="Threads"
          inert={!isDesktop && !mRail}
          className={cx(
            "border-r border-white/[0.07] bg-[#0c0c0e]",
            isDesktop
              ? cx("relative shrink-0 transition-[width] duration-200", railCollapsed ? "w-[60px]" : "w-[288px]")
              : cx("fixed inset-y-0 left-0 z-40 w-[310px] max-w-[88vw] transition-transform duration-200", mRail ? "translate-x-0" : "-translate-x-full"),
          )}
        >
          <ThreadRail
            threads={shownThreads}
            selectedId={scene === "empty" ? null : selectedId}
            onSelect={selectThread}
            onNew={newTask}
            collapsed={railCollapsed}
            onToggle={() => setRailOpen((o) => !o)}
            loading={scene === "loading" && !threads.some((t) => t.id.startsWith("n"))}
            onClose={() => setMRail(false)}
            mobile={!isDesktop}
          />
        </aside>

        {/* center */}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 sm:px-5">
            {!isDesktop && <IconBtn label="Open threads" onClick={() => setMRail(true)}><Menu className="h-4 w-4" /></IconBtn>}
            {sel && scene !== "empty" ? <RoleGlyph role={sel.role} size={28} /> : <RoleGlyph role={role} size={28} />}
            <div className="min-w-0 flex-1 leading-tight">
              <h1 className="truncate text-[14px] font-semibold tracking-tight text-zinc-50">{title}</h1>
              <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-zinc-500">
                {scene === "empty" ? (
                  <span>swarm-7f3a · hibernated</span>
                ) : (
                  <>
                    <StatusDot status={liveStatus} />
                    <span className={STATUS_STYLE[liveStatus].text}>{control ? "You’re in control" : scene === "approval" ? "Needs approval" : STATUS_STYLE[liveStatus].label}</span>
                    <span aria-hidden>·</span>
                    <span className="sa-mono truncate">swarm-7f3a · 2 vCPU · 4 GB</span>
                  </>
                )}
              </p>
            </div>
            <span className="sa-mono hidden rounded-md border border-white/[0.08] px-2 py-1 text-[11.5px] tabular-nums text-zinc-400 sm:block" aria-label={`Thread cost ${money(sessionCost)}`}>{money(sessionCost)}</span>
            {isDesktop ? (
              <IconBtn label={drawerOpen ? "Hide side panel" : "Show side panel"} onClick={() => setDrawerOpen((o) => !o)} active={drawerOpen}>
                {drawerOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
              </IconBtn>
            ) : (
              <IconBtn label="Open files, browser, plan and library" onClick={() => setMDrawer(true)}><PanelRightOpen className="h-4 w-4" /></IconBtn>
            )}
          </header>

          <div className="sa-scroll min-h-0 flex-1 overflow-y-auto px-3 sm:px-5">
            <div className={cx("mx-auto w-full space-y-3 py-3 sm:py-4", CAP)}>
              <ScreenFrame
                scene={scene}
                control={control}
                paused={paused}
                n={n}
                latency={metrics.lat}
                onControl={toggleControl}
                onPause={() => setPaused((p) => !p)}
                onSuggest={(s) => { setDraft(s); document.getElementById("sa-composer")?.focus(); }}
              />
              <Telemetry
                scene={scene}
                control={control}
                paused={paused}
                stopped={stopped}
                n={n}
                elapsed={elapsed}
                steps={steps}
                metrics={metrics}
                onDecide={decide}
                onAction={onAction}
              />
            </div>
          </div>

          <div className="shrink-0 border-t border-white/[0.06] bg-[#09090b] px-3 pb-3 pt-3 sm:px-5 sm:pb-4">
            <div className={cx("mx-auto w-full", CAP)}>
              <Composer
                draft={draft}
                setDraft={setDraft}
                role={role}
                setRole={setRole}
                running={running}
                disabled={control}
                cost={sessionCost}
                cap={2}
                onSend={send}
                onStop={stop}
                scene={scene}
              />
            </div>
          </div>
        </main>

        {/* right drawer */}
        {isDesktop ? (
          drawerOpen && (
            <aside aria-label="Workspace panels" className="w-[360px] shrink-0 border-l border-white/[0.07] bg-[#0c0c0e]">
              <Drawer scene={scene} n={n} onClose={() => setDrawerOpen(false)} mobile={false} />
            </aside>
          )
        ) : (
          <aside
            aria-label="Workspace panels"
            inert={!mDrawer}
            className={cx("fixed inset-x-0 bottom-0 top-16 z-40 rounded-t-2xl border-t border-white/10 bg-[#0c0c0e] transition-transform duration-300", mDrawer ? "translate-y-0" : "translate-y-full")}
          >
            <Drawer scene={scene} n={n} onClose={() => setMDrawer(false)} mobile />
          </aside>
        )}
      </div>
    </div>
  );
}
