/**
 * Step-type icons for the premium timeline.
 * Each agent action type gets a distinct, recognizable SVG icon at 16×16.
 * These use currentColor and inherit the parent's text color.
 */

const size = 16;
const vb = "0 0 24 24";
const base = { width: size, height: size, viewBox: vb, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const, focusable: false as unknown as boolean };

// Brain — thinking
export const IBrain = () => (
  <svg {...base}>
    <path d="M12 2a7 7 0 0 0-4.6 12.3A3 3 0 0 0 9 17h6a3 3 0 0 0 1.6-2.7A7 7 0 0 0 12 2z" />
    <path d="M9 21h6M10 17v4M14 17v4" />
  </svg>
);

// Terminal — shell/bash
export const ITerminal = () => (
  <svg {...base}>
    <path d="M4 17l6-5-6-5" />
    <path d="M12 19h8" />
  </svg>
);

// File text — read_file
export const IFileText = () => (
  <svg {...base}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
  </svg>
);

// File plus — write_file
export const IFilePlus = () => (
  <svg {...base}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M12 18v-6M9 15h6" />
  </svg>
);

// Pencil — edit_file
export const IPencil = () => (
  <svg {...base}>
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  </svg>
);

// Search — search/grep
export const ISearch = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

// Globe — browser
export const IGlobe = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" />
  </svg>
);

// Globe with magnifying glass — web_search
export const IGlobeSearch = () => (
  <svg {...base}>
    <path d="M21 12a9 9 0 1 0-4 7.5" />
    <path d="M3.6 9h16.8M3.6 15h8" />
    <circle cx="19" cy="19" r="3" />
    <path d="M22 22l-1.5-1.5" />
  </svg>
);

// Download — web_fetch
export const IDownload = () => (
  <svg {...base}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </svg>
);

// List checks — plan
export const IListChecks = () => (
  <svg {...base}>
    <path d="M10 6h11M10 12h11M10 18h11" />
    <path d="M3 6l2 2 4-4M3 18l2 2 4-4" />
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
);

// Undo — restore_checkpoint
export const IUndo = () => (
  <svg {...base}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.7 3L3 13" />
  </svg>
);

// Plug — MCP connector
export const IPlug = () => (
  <svg {...base}>
    <path d="M12 22v-5M9 7V2M15 7V2M5 7h14v5a7 7 0 0 1-14 0z" />
  </svg>
);

// Robot — sub-agent
export const IRobot = () => (
  <svg {...base}>
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <circle cx="12" cy="5" r="3" />
    <path d="M12 8v3M8 16h0M16 16h0" />
  </svg>
);

// Compress — compaction
export const ICompress = () => (
  <svg {...base}>
    <path d="M4 14h16M4 10h16M8 6l4 4 4-4M8 18l4-4 4 4" />
  </svg>
);

// Zap — api_request
export const IZap = () => (
  <svg {...base}>
    <path d="M13 2L3 14h9l-1 8 10-12h-9z" fill="none" />
  </svg>
);

// Message circle — text response
export const IMessage = () => (
  <svg {...base}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

// Info circle — notice
export const IInfo = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
);

// Alert triangle — warning notice
export const IAlert = () => (
  <svg {...base}>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);

/** Get the icon component for a given step. */
export function stepIcon(type: string, name?: string, level?: string): React.ComponentType {
  if (type === "thinking") return IBrain;
  if (type === "text") return IMessage;
  if (type === "compaction") return ICompress;
  if (type === "plan") return IListChecks;
  if (type === "notice") return level === "warn" || level === "error" ? IAlert : IInfo;
  if (type !== "tool") return IInfo;

  // Tool-specific icons
  switch (name) {
    case "bash": return ITerminal;
    case "read_file": return IFileText;
    case "write_file": return IFilePlus;
    case "edit_file": return IPencil;
    case "restore_checkpoint": return IUndo;
    case "search": return ISearch;
    case "web_search": return IGlobeSearch;
    case "web_fetch": return IDownload;
    case "browser": return IGlobe;
    case "plan": return IListChecks;
    case "subagent": return IRobot;
    case "api_request": return IZap;
    default:
      if (name?.startsWith("mcp__")) return IPlug;
      return IZap;
  }
}

/** CSS class for the left-border accent color on tool cards. */
export function toolAccent(name: string): string {
  switch (name) {
    case "bash": return "tool-accent-shell";
    case "read_file":
    case "write_file":
    case "edit_file":
    case "restore_checkpoint":
      return "tool-accent-file";
    case "browser": return "tool-accent-browser";
    case "search":
    case "web_search":
    case "web_fetch":
      return "tool-accent-search";
    case "api_request": return "tool-accent-api";
    default:
      if (name?.startsWith("mcp__")) return "tool-accent-mcp";
      return "";
  }
}
