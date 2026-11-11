import { AGENT_ROLES } from '@/lib/agentRoles';
import type { SandboxStatus } from '@/lib/sandboxTypes';

export interface SpatialNode {
  id: string;
  agentId: string;
  roleId: string;
  parentId?: string | null;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  status: SandboxStatus;
  label: string;
  assignedModel?: string;
  modelTier?: string;
  activity?: 'idle' | 'working' | 'communicating';
  providerName?: string;
}

export interface SpatialEdge {
  id: string;
  source: string;
  target: string;
  path: string;
  particleSpeed: number;
  active?: boolean;
}

export interface LayoutOptions {
  peerGapX?: number;
  peerGapY?: number;
  subagentGapX?: number;
  subagentGapY?: number;
  nodeWidth?: number;
  nodeHeight?: number;
}

export function computeSpatialLayout(
  agents: Array<{
    id: string;
    roleId: string;
    parentId?: string | null;
    status?: SandboxStatus;
    label?: string;
    assignedModel?: string;
    modelTier?: string;
    activity?: SpatialNode['activity'];
    providerName?: string;
  }>,
  options: LayoutOptions = {},
): {
  nodes: SpatialNode[];
  edges: SpatialEdge[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number };
} {
  const nodeWidth = options.nodeWidth || 280;
  const nodeHeight = options.nodeHeight || 180;
  const peerGapX = options.peerGapX || 80;
  const peerGapY = options.peerGapY || 100;
  const subagentGapX = options.subagentGapX || 40;
  const subagentGapY = options.subagentGapY || 240;

  const roots = agents.filter((a) => !a.parentId);
  const childrenMap = new Map<string, typeof agents>();
  agents.forEach((a) => {
    if (a.parentId) {
      const list = childrenMap.get(a.parentId) || [];
      list.push(a);
      childrenMap.set(a.parentId, list);
    }
  });

  const nodes: SpatialNode[] = [];
  const edges: SpatialEdge[] = [];

  const numRoots = roots.length || 1;
  const columns = Math.min(Math.ceil(Math.sqrt(numRoots)), 6);
  const totalRootWidth = columns * (nodeWidth + peerGapX) - peerGapX;
  const startX = -totalRootWidth / 2;

  function layoutSubtree(parentId: string, parentX: number, parentY: number, depth: number): number {
    const children = childrenMap.get(parentId) || [];
    if (!children.length) return nodeWidth;

    const childY = parentY + subagentGapY;
    let totalChildrenWidth = 0;
    const childWidths: number[] = [];

    children.forEach((c) => {
      const grandKids = childrenMap.get(c.id) || [];
      const w = grandKids.length > 0 ? grandKids.length * (nodeWidth + subagentGapX) : nodeWidth;
      childWidths.push(w);
      totalChildrenWidth += w + subagentGapX;
    });
    totalChildrenWidth -= subagentGapX;

    let currentX = parentX + nodeWidth / 2 - totalChildrenWidth / 2;

    children.forEach((child, idx) => {
      const cWidth = childWidths[idx];
      const childX = currentX + cWidth / 2 - nodeWidth / 2;
      const role = AGENT_ROLES.find((r) => r.id === child.roleId);

      nodes.push({
        id: child.id,
        agentId: child.id,
        roleId: child.roleId,
        parentId,
        depth,
        x: childX,
        y: childY,
        width: nodeWidth,
        height: nodeHeight,
        status: child.status || 'idle',
        label: child.label || child.id,
        assignedModel: child.assignedModel,
        modelTier: child.modelTier || role?.model_tier || 'strong',
        activity: child.activity || 'idle',
        providerName: child.providerName,
      });

      const sourceX = parentX + nodeWidth / 2;
      const sourceY = parentY + nodeHeight;
      const targetX = childX + nodeWidth / 2;
      const targetY = childY;
      const midY = (sourceY + targetY) / 2;
      const bezierPath = `M ${sourceX} ${sourceY} C ${sourceX} ${midY}, ${targetX} ${midY}, ${targetX} ${targetY}`;

      edges.push({
        id: `e-${parentId}-${child.id}`,
        source: parentId,
        target: child.id,
        path: bezierPath,
        particleSpeed: 1.5 + depth * 0.2,
        active: child.activity === 'communicating' || child.activity === 'working',
      });

      layoutSubtree(child.id, childX, childY, depth + 1);
      currentX += cWidth + subagentGapX;
    });

    return Math.max(nodeWidth, totalChildrenWidth);
  }

  roots.forEach((root, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const rootX = startX + col * (nodeWidth + peerGapX);
    const rootY = row * (nodeHeight + peerGapY);
    const role = AGENT_ROLES.find((r) => r.id === root.roleId);

    nodes.push({
      id: root.id,
      agentId: root.id,
      roleId: root.roleId,
      parentId: null,
      depth: 0,
      x: rootX,
      y: rootY,
      width: nodeWidth,
      height: nodeHeight,
      status: root.status || 'idle',
      label: root.label || root.id,
      assignedModel: root.assignedModel,
      modelTier: root.modelTier || role?.model_tier || 'frontier',
      activity: root.activity || 'idle',
      providerName: root.providerName,
    });

    layoutSubtree(root.id, rootX, rootY, 1);
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  nodes.forEach((n) => {
    if (n.x < minX) minX = n.x;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y < minY) minY = n.y;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  });

  if (nodes.length === 0) {
    minX = maxX = minY = maxY = 0;
  }

  return {
    nodes,
    edges,
    bounds: {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
  };
}

export function calculateFocusZoom(
  targetNode: SpatialNode,
  viewportWidth: number,
  viewportHeight: number,
  targetZoom = 1.0,
): { x: number; y: number; zoom: number } {
  const centerX = targetNode.x + targetNode.width / 2;
  const centerY = targetNode.y + targetNode.height / 2;
  const cameraX = centerX - viewportWidth / (2 * targetZoom);
  const cameraY = centerY - viewportHeight / (2 * targetZoom);
  return { x: cameraX, y: cameraY, zoom: targetZoom };
}
