/**
 * A tiny mermaid renderer.
 *
 * The architecture lens answers with a mermaid diagram, and the UI has to
 * show it as a diagram — not as a wall of source. This module parses the
 * flowchart subset of mermaid (nodes, edges, edge labels, direction) and
 * lays it out in layers, so the UI can draw it as plain SVG without pulling
 * in a diagram library.
 *
 * Anything it does not understand is reported as "not a diagram" so the UI
 * can fall back to showing the raw mermaid source.
 */

export type MermaidShape = "rect" | "stadium" | "circle" | "diamond" | "subroutine" | "cylinder";

export interface MermaidNode {
  id: string;
  label: string;
  shape: MermaidShape;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  thick?: boolean;
}

export interface MermaidGraph {
  /** "TB" = top to bottom, "LR" = left to right. */
  direction: "TB" | "LR";
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

export interface PositionedNode extends MermaidNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedEdge extends MermaidEdge {
  /** Polyline points from the source node to the target node. */
  points: Array<{ x: number; y: number }>;
  /** Where the edge label sits. */
  labelX: number;
  labelY: number;
}

export interface MermaidLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

const NODE_HEIGHT = 36;
const SIDE_GAP = 26;
const LAYER_GAP = 56;
const MARGIN = 16;
const CHAR_WIDTH = 7;

const SHAPES: ReadonlyArray<{ re: RegExp; shape: MermaidShape }> = [
  { re: /^\[\[(.+)\]\]$/, shape: "subroutine" },
  { re: /^\[\((.+)\)\]$/, shape: "cylinder" },
  { re: /^\(\((.+)\)\)$/, shape: "circle" },
  { re: /^\{(.+)\}$/, shape: "diamond" },
  { re: /^\[(.+)\]$/, shape: "rect" },
  { re: /^\((.+)\)$/, shape: "stadium" },
];

function unquote(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface NodeToken {
  id: string;
  label?: string;
  shape?: MermaidShape;
}

/** Parse one node reference such as `A`, `A[Label]` or `A((Label))`. */
export function parseNodeToken(token: string): NodeToken | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const match = /^([A-Za-z0-9_.-]+)\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  const id = match[1];
  const rest = match[2].trim();
  if (!rest) return { id };
  for (const { re, shape } of SHAPES) {
    const shaped = re.exec(rest);
    if (shaped) return { id, label: unquote(shaped[1]), shape };
  }
  return { id };
}

/** Normalise the arrow spellings mermaid accepts into a single "-->" form. */
export function normalizeArrow(line: string): string {
  return line
    .replace(/-\.->/g, "-->")
    .replace(/==>/g, "-->")
    .replace(/--\s*([^->|]+?)\s*-->/g, (_match, label: string) => `-->|${label.trim()}|`)
    .replace(/---/g, "-->");
}

/**
 * Parse the flowchart subset of mermaid. Returns null when the source is not
 * a diagram this renderer understands.
 */
export function parseMermaid(source: string): MermaidGraph | null {
  const lines = (source ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));
  if (lines.length === 0) return null;

  const header = /^(flowchart|graph)\s*(TB|TD|BT|LR|RL)?\b/i.exec(lines[0]);
  if (!header) return null;
  const rawDirection = (header[2] ?? "TB").toUpperCase();
  const direction: "TB" | "LR" = rawDirection === "LR" || rawDirection === "RL" ? "LR" : "TB";

  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  const register = (token: NodeToken): void => {
    const existing = nodes.get(token.id);
    if (!existing) {
      nodes.set(token.id, {
        id: token.id,
        label: token.label ?? token.id,
        shape: token.shape ?? "rect",
      });
      return;
    }
    if (token.label && existing.label === existing.id) {
      existing.label = token.label;
      if (token.shape) existing.shape = token.shape;
    }
  };

  for (const raw of lines.slice(1)) {
    const line = raw.replace(/;\s*$/, "").trim();
    if (!line) continue;
    if (/^(subgraph|end|classDef|style|class|click|linkStyle|direction)\b/i.test(line)) continue;

    const dashed = line.includes("-.->");
    const thick = line.includes("==>");
    const normalized = normalizeArrow(line);
    if (!normalized.includes("-->")) continue;

    const segments = normalized.split("-->").map((segment) => segment.trim());
    let previous: NodeToken[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const labelMatch = /^\|([^|]*)\|/.exec(segment);
      const label = labelMatch ? unquote(labelMatch[1]) : "";
      const rest = labelMatch ? segment.slice(labelMatch[0].length).trim() : segment;
      const tokens = rest
        .split("&")
        .map((token) => parseNodeToken(token))
        .filter((token): token is NodeToken => token !== null);
      if (tokens.length === 0) continue;
      for (const token of tokens) register(token);
      if (index > 0 && previous.length > 0) {
        for (const from of previous) {
          for (const to of tokens) {
            if (from.id === to.id) continue;
            edges.push({
              from: from.id,
              to: to.id,
              ...(label ? { label } : {}),
              ...(dashed ? { dashed } : {}),
              ...(thick ? { thick } : {}),
            });
          }
        }
      }
      previous = tokens;
    }
  }

  if (nodes.size === 0) return null;
  return { direction, nodes: [...nodes.values()], edges };
}

function nodeSize(node: MermaidNode): { width: number; height: number } {
  const textWidth = Math.max(24, node.label.length * CHAR_WIDTH + 26);
  if (node.shape === "circle") {
    const size = Math.max(46, textWidth);
    return { width: size, height: size };
  }
  return { width: textWidth, height: NODE_HEIGHT };
}

/**
 * Lay the graph out in layers: every node sits one level below its deepest
 * incoming edge, and the levels are drawn top to bottom (or left to right).
 */
export function layoutMermaid(graph: MermaidGraph): MermaidLayout {
  const sizeById = new Map<string, { width: number; height: number }>();
  for (const node of graph.nodes) sizeById.set(node.id, nodeSize(node));

  const depth = new Map<string, number>();
  for (const node of graph.nodes) depth.set(node.id, 0);
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of graph.edges) {
      const from = depth.get(edge.from) ?? 0;
      const to = depth.get(edge.to) ?? 0;
      if (to < from + 1) {
        depth.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const layers: string[][] = [];
  for (const node of graph.nodes) {
    const level = depth.get(node.id) ?? 0;
    layers[level] ??= [];
    layers[level].push(node.id);
  }

  const vertical = graph.direction === "TB";
  const placed = new Map<string, PositionedNode>();

  if (vertical) {
    // Top to bottom: every level is a row, the widest row sets the width.
    const extents = layers.map((ids) => {
      const sizes = (ids ?? []).map((id) => sizeById.get(id) ?? { width: 60, height: NODE_HEIGHT });
      return sizes.reduce((sum, size) => sum + size.width, 0) + SIDE_GAP * Math.max(0, sizes.length - 1);
    });
    const contentWidth = Math.max(0, ...extents);
    layers.forEach((ids, level) => {
      if (!ids || ids.length === 0) return;
      const sizes = ids.map((id) => sizeById.get(id) ?? { width: 60, height: NODE_HEIGHT });
      let cursor = MARGIN + (contentWidth - (extents[level] ?? 0)) / 2;
      ids.forEach((id, index) => {
        const size = sizes[index];
        placed.set(id, {
          id,
          label: "",
          shape: "rect",
          x: cursor,
          y: MARGIN + level * (NODE_HEIGHT + LAYER_GAP),
          width: size.width,
          height: size.height,
        });
        cursor += size.width + SIDE_GAP;
      });
    });
  } else {
    // Left to right: every level is a column, the widest node sets the gap.
    const columnWidth = Math.max(
      80,
      ...graph.nodes.map((node) => sizeById.get(node.id)?.width ?? 0),
    );
    layers.forEach((ids, level) => {
      if (!ids || ids.length === 0) return;
      let cursor = MARGIN;
      for (const id of ids) {
        const size = sizeById.get(id) ?? { width: 60, height: NODE_HEIGHT };
        placed.set(id, {
          id,
          label: "",
          shape: "rect",
          x: MARGIN + level * (columnWidth + LAYER_GAP),
          y: cursor,
          width: size.width,
          height: size.height,
        });
        cursor += size.height + SIDE_GAP;
      }
    });
  }

  let maxWidth = 0;
  let maxHeight = 0;
  for (const node of graph.nodes) {
    const position = placed.get(node.id);
    if (!position) continue;
    position.label = node.label;
    position.shape = node.shape;
    maxWidth = Math.max(maxWidth, position.x + position.width + MARGIN);
    maxHeight = Math.max(maxHeight, position.y + position.height + MARGIN);
  }

  const edges: PositionedEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const points = clipLine(from, to, start, end);
    const first = points[0] ?? start;
    const last = points[points.length - 1] ?? end;
    edges.push({
      ...edge,
      points,
      labelX: (first.x + last.x) / 2,
      labelY: (first.y + last.y) / 2 - 6,
    });
  }

  return {
    nodes: [...placed.values()],
    edges,
    width: Math.max(maxWidth, 120),
    height: Math.max(maxHeight, 80),
  };
}

/**
 * Trim a centre-to-centre line so it starts and ends at the node borders
 * instead of running under the boxes.
 */
function clipLine(
  from: PositionedNode,
  to: PositionedNode,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return [start, end];
  const exit = (node: PositionedNode, sign: 1 | -1): { x: number; y: number } => {
    const halfWidth = node.width / 2;
    const halfHeight = node.height / 2;
    const tx = Math.abs(dx) < Number.EPSILON ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
    const ty = Math.abs(dy) < Number.EPSILON ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
    const t = Math.min(tx, ty);
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    return { x: cx + sign * dx * t, y: cy + sign * dy * t };
  };
  return [exit(from, 1), exit(to, -1)];
}
