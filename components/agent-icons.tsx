// SwarmAgents agent icon set: 20 hand-built 24px glyphs recreated from Jimmy's sheet (brand-src/agent-icons-sheet.png).
// Gold / orange line strokes and blue node dots, round caps and joins. Colors are three CSS variables
// (--agent-icon-gold, --agent-icon-orange, --agent-icon-dot; see components/agent-icons.css and lib/design-tokens.ts),
// so they theme for light and dark, and `mono` collapses all three to currentColor.
// Static copies of every glyph: public/brand/icons/<kebab-name>.svg.
import type { CSSProperties, ComponentType, ReactNode } from "react";

export type AgentIconName = "orchestrator" | "researcher" | "planner" | "coder" | "reviewer" | "debugger" | "executor" | "toolConnector" | "sandbox" | "guardian" | "memory" | "knowledgeGraph" | "modelCore" | "messageBus" | "router" | "scheduler" | "trigger" | "observer" | "approvalGate" | "swarm";

export const AGENT_ICON_NAMES: AgentIconName[] = ["orchestrator", "researcher", "planner", "coder", "reviewer", "debugger", "executor", "toolConnector", "sandbox", "guardian", "memory", "knowledgeGraph", "modelCore", "messageBus", "router", "scheduler", "trigger", "observer", "approvalGate", "swarm"];

export const AGENT_ICON_LABELS: Record<AgentIconName, string> = {
  orchestrator: "Orchestrator",
  researcher: "Researcher",
  planner: "Planner",
  coder: "Coder",
  reviewer: "Reviewer",
  debugger: "Debugger",
  executor: "Executor",
  toolConnector: "Tool connector",
  sandbox: "Sandbox",
  guardian: "Guardian",
  memory: "Memory",
  knowledgeGraph: "Knowledge graph",
  modelCore: "Model core",
  messageBus: "Message bus",
  router: "Router",
  scheduler: "Scheduler",
  trigger: "Trigger",
  observer: "Observer",
  approvalGate: "Approval gate",
  swarm: "SwarmAgents",
};

// Fallbacks keep the icons colored even where agent-icons.css isn't loaded.
const GOLD = "var(--agent-icon-gold, #E8B84A)";
const ORANGE = "var(--agent-icon-orange, #C97A3C)";
const DOT = "var(--agent-icon-dot, #5FB0D8)";
const SG: CSSProperties = { stroke: GOLD };
const SO: CSSProperties = { stroke: ORANGE };
const FG: CSSProperties = { fill: GOLD, stroke: "none" };
const FO: CSSProperties = { fill: ORANGE, stroke: "none" };
const FD: CSSProperties = { fill: DOT, stroke: "none" };
const MONO = { "--agent-icon-gold": "currentColor", "--agent-icon-orange": "currentColor", "--agent-icon-dot": "currentColor" } as CSSProperties;

const GLYPHS: Record<AgentIconName, ReactNode> = {
  orchestrator: (
    <>
      <path d="M15.6 12.0 L13.8 15.12 L10.2 15.12 L8.4 12.0 L10.2 8.88 L13.8 8.88 Z" style={SG} />
      <circle cx="12" cy="12" r="1.3" style={FG} />
      <path d="M12.0 8.88 L12.0 4.4" style={SO} />
      <circle cx="12" cy="3.4" r="1.15" style={FD} />
      <path d="M12.0 15.12 L12.0 19.6" style={SO} />
      <circle cx="12" cy="20.6" r="1.15" style={FD} />
      <path d="M14.7 10.44 L18.58 8.2" style={SO} />
      <circle cx="19.45" cy="7.7" r="1.15" style={FD} />
      <path d="M14.7 13.56 L18.58 15.8" style={SO} />
      <circle cx="19.45" cy="16.3" r="1.15" style={FD} />
      <path d="M9.3 13.56 L5.42 15.8" style={SO} />
      <circle cx="4.55" cy="16.3" r="1.15" style={FD} />
      <path d="M9.3 10.44 L5.42 8.2" style={SO} />
      <circle cx="4.55" cy="7.7" r="1.15" style={FD} />
    </>
  ),
  researcher: (
    <>
      <circle cx="10" cy="10" r="6.2" style={SG} />
      <path d="M14.4 14.4 L19.4 19.4" style={SG} />
      <circle cx="20" cy="20" r="1.15" style={FD} />
      <path d="M6.6 11.4 H8.6 L10.2 9.2 H12" style={SO} />
      <circle cx="12.9" cy="9.2" r="1.15" style={FD} />
    </>
  ),
  planner: (
    <>
      <path d="M3.5 20 H8 V15.5 H12.5 V11 H17 V7.5" style={SG} />
      <circle cx="3.3" cy="20" r="1.15" style={FD} />
      <circle cx="8" cy="15.5" r="1.15" style={FD} />
      <circle cx="12.5" cy="11" r="1.15" style={FD} />
      <path d="M17 7 V2.8 L20.6 4 L17 5.2" style={SO} />
      <circle cx="17" cy="7.4" r="1.45" style={FG} />
    </>
  ),
  coder: (
    <>
      <path d="M8 6.5 L3.5 12 L8 17.5" style={SG} />
      <path d="M16 6.5 L20.5 12 L16 17.5" style={SG} />
      <path d="M13.4 5.6 L10.6 18.4" style={SO} />
      <circle cx="13.5" cy="5.2" r="1.15" style={FD} />
      <circle cx="10.5" cy="18.8" r="1.15" style={FD} />
    </>
  ),
  reviewer: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2.2" style={SG} />
      <path d="M8.5 7.5 H13" style={SO} />
      <path d="M8.5 10.5 H15.5" style={SO} />
      <path d="M9 15.6 L11.2 17.8 L15.4 13.6" style={SG} />
      <circle cx="19" cy="3.2" r="1.15" style={FD} />
    </>
  ),
  debugger: (
    <>
      <circle cx="12" cy="6.4" r="2" style={SG} />
      <ellipse cx="12" cy="14.2" rx="3.8" ry="5.2" style={SG} />
      <path d="M10.8 4.8 L9.6 2.8" style={SO} />
      <path d="M13.2 4.8 L14.4 2.8" style={SO} />
      <path d="M8.10 11 H5.40 L4.20 9.6" style={SO} />
      <circle cx="3.6" cy="9.3" r="1.15" style={FD} />
      <path d="M8.00 14.2 H4.40" style={SO} />
      <circle cx="3.4" cy="14.2" r="1.15" style={FD} />
      <path d="M8.10 17.4 H5.40 L4.20 18.8" style={SO} />
      <circle cx="3.6" cy="19.1" r="1.15" style={FD} />
      <path d="M15.90 11 H18.60 L19.80 9.6" style={SO} />
      <circle cx="20.4" cy="9.3" r="1.15" style={FD} />
      <path d="M16.00 14.2 H19.60" style={SO} />
      <circle cx="20.6" cy="14.2" r="1.15" style={FD} />
      <path d="M15.90 17.4 H18.60 L19.80 18.8" style={SO} />
      <circle cx="20.4" cy="19.1" r="1.15" style={FD} />
    </>
  ),
  executor: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" style={SG} />
      <path d="M2.5 8.2 H21.5" style={SO} />
      <circle cx="5.3" cy="6.1" r="0.85" style={FD} />
      <circle cx="7.8" cy="6.1" r="0.85" style={FD} />
      <path d="M7 11.2 L9.6 13.4 L7 15.6" style={SO} />
      <path d="M11.8 15.6 H16" style={SO} />
    </>
  ),
  toolConnector: (
    <>
      <rect x="7.5" y="8" width="9" height="6" rx="2" style={SG} />
      <path d="M10 8 V4.6" style={SO} />
      <path d="M14 8 V4.6" style={SO} />
      <circle cx="10" cy="3.9" r="1.15" style={FD} />
      <circle cx="14" cy="3.9" r="1.15" style={FD} />
      <path d="M12 14 V17 A2.5 2.5 0 0 0 14.5 19.5 H19" style={SO} />
      <circle cx="19.7" cy="19.5" r="1.15" style={FD} />
    </>
  ),
  sandbox: (
    <>
      <path d="M12.0 3.4 L19.45 7.7 L19.45 16.3 L12.0 20.6 L4.55 16.3 L4.55 7.7 Z" style={SG} />
      <path d="M4.55 7.7 L12 12 L19.45 7.7 M12 12 V20.6" style={SO} />
      <circle cx="12" cy="12" r="1.4" style={FG} />
    </>
  ),
  guardian: (
    <>
      <path d="M12 3 L19 5.8 V11.4 C19 15.9 16 19.2 12 21 C8 19.2 5 15.9 5 11.4 V5.8 Z" style={SG} />
      <circle cx="12" cy="3" r="1.15" style={FD} />
      <circle cx="12" cy="10.4" r="1.9" style={SO} />
      <path d="M12 12.3 V15.2" style={SO} />
    </>
  ),
  memory: (
    <>
      <path d="M12 4.4 L20 8.4 L12 12.4 L4 8.4 Z" style={SG} />
      <circle cx="12" cy="8.4" r="1.3" style={FG} />
      <path d="M4 12.2 L12 16.2 L20 12.2" style={SO} />
      <path d="M4.6 15.9 L12 19.6 L19.4 15.9" style={SO} />
      <circle cx="3.9" cy="15.5" r="1.15" style={FD} />
      <circle cx="20.1" cy="15.5" r="1.15" style={FD} />
    </>
  ),
  knowledgeGraph: (
    <>
      <path d="M11.09 6.38 L6.11 16.22 M12.91 6.38 L17.89 16.22 M7.20 18.00 L16.80 18.00 M12.00 12.30 L12.00 6.60 M10.91 14.31 L6.88 16.91 M13.09 14.31 L17.12 16.91" style={SO} />
      <circle cx="12" cy="4.6" r="2" style={SG} />
      <circle cx="5.2" cy="18" r="2" style={SG} />
      <circle cx="18.8" cy="18" r="2" style={SG} />
      <circle cx="12" cy="13.6" r="1.3" style={FG} />
    </>
  ),
  modelCore: (
    <>
      <path d="M9.5 7 V4.5 M14.5 7 V4.5 M9.5 17 V19.5 M14.5 17 V19.5 M7 9.5 H4.5 M7 14.5 H4.5 M17 9.5 H19.5 M17 14.5 H19.5 M12 7 V3.6 M12 17 V20.4 M7 12 H3.6 M17 12 H20.4" style={SO} />
      <rect x="7" y="7" width="10" height="10" rx="2.2" style={SG} />
      <rect x="10" y="10" width="4" height="4" rx="0.9" style={SO} />
      <circle cx="12" cy="2.9" r="1.15" style={FD} />
      <circle cx="12" cy="21.1" r="1.15" style={FD} />
      <circle cx="2.9" cy="12" r="1.15" style={FD} />
      <circle cx="21.1" cy="12" r="1.15" style={FD} />
    </>
  ),
  messageBus: (
    <>
      <path d="M4.6 6.5 H20.4 M18.2 4.4 L20.4 6.5 L18.2 8.6" style={SO} />
      <circle cx="3.4" cy="6.5" r="1.15" style={FD} />
      <rect x="6.2" y="5.25" width="3" height="2.5" rx="1.25" style={FG} />
      <path d="M4.6 12 H20.4 M18.2 9.9 L20.4 12 L18.2 14.1" style={SO} />
      <circle cx="3.4" cy="12" r="1.15" style={FD} />
      <rect x="11.6" y="10.75" width="4" height="2.5" rx="1.25" style={FG} />
      <path d="M4.6 17.5 H20.4 M18.2 15.4 L20.4 17.5 L18.2 19.6" style={SO} />
      <circle cx="3.4" cy="17.5" r="1.15" style={FD} />
      <rect x="8" y="16.25" width="3.2" height="2.5" rx="1.25" style={FG} />
    </>
  ),
  router: (
    <>
      <circle cx="3.6" cy="12" r="1.5" style={FG} />
      <path d="M5.1 12 H8.8" style={SO} />
      <path d="M12 8.8 L15.2 12 L12 15.2 L8.8 12 Z" style={SG} />
      <path d="M15.2 12 H20 M15.6 11.4 L18 6.6 H20 M15.6 12.6 L18 17.4 H20" style={SO} />
      <circle cx="20.9" cy="6.6" r="1.15" style={FD} />
      <circle cx="20.9" cy="12" r="1.15" style={FD} />
      <circle cx="20.9" cy="17.4" r="1.15" style={FD} />
    </>
  ),
  scheduler: (
    <>
      <circle cx="12" cy="12" r="8.6" style={SG} />
      <path d="M12 3.4 V5 M20.6 12 H19 M12 20.6 V19 M3.4 12 H5" style={SO} />
      <path d="M12 12 V6.8 M12 12 L15 14.2" style={SO} />
      <circle cx="15.6" cy="14.6" r="1.15" style={FD} />
      <circle cx="12" cy="12" r="1.4" style={FG} />
    </>
  ),
  trigger: (
    <>
      <path d="M13.6 2.8 L7.2 13 H12 L10.4 21.2 L16.8 11 H12 Z" style={SG} />
      <path d="M5 6.4 H7.6" style={SO} />
      <circle cx="3.7" cy="6.4" r="1.15" style={FD} />
      <path d="M16.4 17.6 H19" style={SO} />
      <circle cx="20.3" cy="17.6" r="1.15" style={FD} />
    </>
  ),
  observer: (
    <>
      <path d="M2.6 12 C6.2 5.8 17.8 5.8 21.4 12 C17.8 18.2 6.2 18.2 2.6 12 Z" style={SG} />
      <circle cx="12" cy="12" r="3" style={SO} />
      <circle cx="12" cy="12" r="1.4" style={FG} />
      <circle cx="2.6" cy="12" r="1.15" style={FD} />
      <circle cx="21.4" cy="12" r="1.15" style={FD} />
    </>
  ),
  approvalGate: (
    <>
      <circle cx="9.4" cy="8.6" r="2.8" style={SG} />
      <path d="M4 20.2 A5.4 5.4 0 0 1 14.8 20.2" style={SG} />
      <circle cx="4" cy="20.2" r="1.15" style={FD} />
      <circle cx="14.8" cy="20.2" r="1.15" style={FD} />
      <circle cx="17.6" cy="6.4" r="3.3" style={SO} />
      <path d="M16.1 6.5 L17.2 7.6 L19.2 5.4" style={SO} />
    </>
  ),
  swarm: (
    <>
      <path d="M12.0 3.1 L15.03 4.85 L15.03 8.35 L12.0 10.1 L8.97 8.35 L8.97 4.85 Z" style={SG} />
      <circle cx="12" cy="6.6" r="1" style={FD} />
      <path d="M8.88 8.5 L11.91 10.25 L11.91 13.75 L8.88 15.5 L5.85 13.75 L5.85 10.25 Z" style={SO} />
      <circle cx="8.88" cy="12" r="1" style={FD} />
      <path d="M15.12 8.5 L18.15 10.25 L18.15 13.75 L15.12 15.5 L12.09 13.75 L12.09 10.25 Z" style={SO} />
      <circle cx="15.12" cy="12" r="1" style={FD} />
      <path d="M12.0 13.9 L15.03 15.65 L15.03 19.15 L12.0 20.9 L8.97 19.15 L8.97 15.65 Z" style={SG} />
      <circle cx="12" cy="17.4" r="1" style={FD} />
    </>
  ),
};

export interface AgentIconProps {
  name: AgentIconName;
  /** Rendered size in px (the glyph is drawn on a 24px grid). Default 16. */
  size?: number;
  /** One color: every stroke and dot uses currentColor. */
  mono?: boolean;
  /** Draw the dark folded-corner tile from the sheet behind the glyph (empty states, galleries). */
  tile?: boolean;
  /** Stroke width in grid units. Default 1.5, or 1.25 for tiles and sizes of 40px and up. */
  strokeWidth?: number;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function AgentIcon({ name, size = 16, mono, tile, strokeWidth, title, className, style }: AgentIconProps) {
  const sw = strokeWidth ?? (tile || size >= 40 ? 1.25 : 1.5);
  const cls = ["agent-icon", tile && "agent-icon--tile", mono && "agent-icon--mono", className].filter(Boolean).join(" ");
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={tile ? "-5 -5 34 34" : "0 0 24 24"}
      width={size}
      height={size}
      className={cls}
      style={mono ? { ...MONO, ...style } : style}
      fill="none"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: "false" })}
    >
      {title && <title>{title}</title>}
      {tile && (
        <g className="agent-icon-tile">
          <path d="M-4.5 -4.5 H23 L28.5 1 V28.5 H-4.5 Z" style={{ fill: "var(--agent-icon-tile, #0E1118)", stroke: "var(--agent-icon-tile-edge, #2A3142)" }} strokeWidth={0.5} />
          <path d="M23 -4.5 L28.5 1 H23 Z" style={{ fill: "var(--agent-icon-fold, #1B2130)", stroke: "none" }} />
        </g>
      )}
      {GLYPHS[name]}
    </svg>
  );
}

function make(name: AgentIconName): ComponentType {
  const C = () => <AgentIcon name={name} />;
  C.displayName = `AgentIcon(${name})`;
  return C;
}

/** Zero-prop 16px components, drop-in replacements for components/StepIcons.tsx icons. */
export const AgentIcons = {
  Orchestrator: make("orchestrator"),
  Researcher: make("researcher"),
  Planner: make("planner"),
  Coder: make("coder"),
  Reviewer: make("reviewer"),
  Debugger: make("debugger"),
  Executor: make("executor"),
  ToolConnector: make("toolConnector"),
  Sandbox: make("sandbox"),
  Guardian: make("guardian"),
  Memory: make("memory"),
  KnowledgeGraph: make("knowledgeGraph"),
  ModelCore: make("modelCore"),
  MessageBus: make("messageBus"),
  Router: make("router"),
  Scheduler: make("scheduler"),
  Trigger: make("trigger"),
  Observer: make("observer"),
  ApprovalGate: make("approvalGate"),
  Swarm: make("swarm"),
} satisfies Record<string, ComponentType>;

/**
 * Which agent icon fits a timeline step. Returns null when nothing fits (callers keep their own icon).
 * type: AgentEvent type ("thinking", "tool", "plan", "compaction", "notice", "turn", …) or a runtime kind
 * ("approval", "schedule", "trigger", "sandbox", "router", "subagent"); name: tool name; level: notice level,
 * or "error" for a failed tool call.
 */
export function agentIconForStep(type: string, name?: string, level?: string): AgentIconName | null {
  switch (type) {
    case "thinking":
    case "text":
    case "model":
      return "modelCore";
    case "plan":
      return "planner";
    case "compaction":
    case "memory":
      return "memory";
    case "notice":
      return level === "error" ? "debugger" : level === "warn" ? "guardian" : "observer";
    case "turn":
    case "router":
      return "router";
    case "approval":
      return "approvalGate";
    case "schedule":
    case "scheduled":
    case "waiting":
      return "scheduler";
    case "trigger":
    case "webhook":
      return "trigger";
    case "sandbox":
      return "sandbox";
    case "subagent":
    case "subagents":
      return "swarm";
    case "orchestrator":
      return "orchestrator";
    case "tool":
      break;
    default:
      return null;
  }
  if (level === "error") return "debugger";
  switch (name) {
    case "bash":
      return "executor";
    case "write_file":
    case "edit_file":
      return "coder";
    case "read_file":
      return "reviewer";
    case "restore_checkpoint":
      return "memory";
    case "search":
    case "web_search":
    case "web_fetch":
      return "researcher";
    case "browser":
      return "observer";
    case "plan":
      return "planner";
    case "subagent":
      return "swarm";
    case "api_request":
      return "trigger";
    default:
      return name?.startsWith("mcp__") ? "toolConnector" : null;
  }
}
