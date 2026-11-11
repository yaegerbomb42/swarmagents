/**
 * Test Models & Domain Utilities for E2E Test Suite.
 * Provides spatial layout algorithms, LOD evaluation, telemetry synthesizers,
 * and test harness helpers matching PROJECT.md and TEST_INFRA.md contracts.
 */

import type { AgentRole } from '@/lib/agentRoles';
import { AGENT_ROLES } from '@/lib/agentRoles';
import type { AgentSandbox, SandboxLogLine, SandboxMode, SandboxStatus } from '@/lib/sandboxTypes';
import {
  computeSpatialLayout,
  calculateFocusZoom,
  type SpatialNode,
  type SpatialEdge,
  type LayoutOptions,
} from '@/lib/spatialLayout';
import type { FileDiff } from '@/lib/parseDiff';
import { parseDiff } from '@/lib/parseDiff';

export type { AgentSandbox, SandboxLogLine, SandboxMode, SandboxStatus };
export type { SpatialNode, SpatialEdge, LayoutOptions };
export { computeSpatialLayout, calculateFocusZoom };

export type ActionType =
  | 'use_browser'
  | 'communicate'
  | 'spawn_subagent'
  | 'create_file'
  | 'think'
  | 'check_blackboard'
  | 'compress_context'
  | 'git_commit'
  | 'file_edit';

export type { DiffLine, FileDiff } from '@/lib/parseDiff';
export { parseDiff } from '@/lib/parseDiff';

export interface AgentAction {
  id: string;
  agentId: string;
  timestamp: number;
  type: ActionType;
  summary: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  coordinates?: { x: number; y: number };
  diff?: FileDiff;
  blackboardNote?: { key: string; value: string; author: string };
  thoughtStream?: { text: string; elapsedSec: number; compressedRatio?: number };
}

export type LodTier = 'micro' | 'standard' | 'full';

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
}

/**
 * Evaluates Level-Of-Detail tier based on canvas zoom level:
 * - Micro chip: zoom < 0.35
 * - Standard card: 0.35 <= zoom <= 0.75
 * - Full interactive sandbox: zoom > 0.75
 */
export function evaluateLodTier(zoom: number): LodTier {
  if (zoom < 0.35) return 'micro';
  if (zoom <= 0.75) return 'standard';
  return 'full';
}

/**
 * Calculates 2D bounding box and culls nodes outside the visible viewport.
 */
export function cullNodesInViewport(nodes: SpatialNode[], viewport: ViewportRect, margin = 50): SpatialNode[] {
  // Screen bounds in world coordinates
  const worldLeft = viewport.x - margin;
  const worldTop = viewport.y - margin;
  const worldRight = viewport.x + viewport.width / viewport.zoom + margin;
  const worldBottom = viewport.y + viewport.height / viewport.zoom + margin;

  return nodes.filter((node) => {
    const nodeRight = node.x + node.width;
    const nodeBottom = node.y + node.height;
    return (
      nodeRight >= worldLeft &&
      node.x <= worldRight &&
      nodeBottom >= worldTop &&
      node.y <= worldBottom
    );
  });
}

/**
 * Formats seconds into HH:MM:SS string.
 */
export function formatActiveTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return [
    hrs.toString().padStart(2, '0'),
    mins.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0'),
  ].join(':');
}

/**
 * Generates synthetic telemetry events for test simulation.
 */
export function createMockAgentAction(agentId: string, type: ActionType, step: number): AgentAction {
  const ts = Date.now() + step * 1000;
  switch (type) {
    case 'use_browser':
      return {
        id: `act_${agentId}_${step}`,
        agentId,
        timestamp: ts,
        type: 'use_browser',
        summary: `Navigated to https://docs.anthropic.com/en/api/overview and clicked search`,
        params: { url: 'https://docs.anthropic.com/en/api/overview', action: 'click' },
        coordinates: { x: 320 + (step * 15) % 400, y: 180 + (step * 25) % 300 },
        result: { status: 200, title: 'Anthropic API Docs' },
      };
    case 'file_edit':
      return {
        id: `act_${agentId}_${step}`,
        agentId,
        timestamp: ts,
        type: 'file_edit',
        summary: `Modified src/lib/roleBindings.ts to score BYOK frontier tiers`,
        params: { filepath: 'src/lib/roleBindings.ts' },
        diff: parseDiff('src/lib/roleBindings.ts', `@@ -60,4 +60,8 @@\n export function scoreTier() {\n-  return 0;\n+  const score = freq * 1.5;\n+  return score + 50;\n }`),
      };
    case 'think':
      return {
        id: `act_${agentId}_${step}`,
        agentId,
        timestamp: ts,
        type: 'think',
        summary: `Evaluating multi-tier bandit distribution for subagent task allocation`,
        thoughtStream: {
          text: `Analyzing 4 potential execution branches. Confidence 0.94. Recommending parallel leaf dispatch.`,
          elapsedSec: 4.2 + (step % 5),
          compressedRatio: 0.72,
        },
      };
    case 'spawn_subagent':
      return {
        id: `act_${agentId}_${step}`,
        agentId,
        timestamp: ts,
        type: 'spawn_subagent',
        summary: `Spawned subagent coder_${step} to implement test cases`,
        params: { role: 'implementer', parentId: agentId, childId: `child_${agentId}_${step}` },
      };
    case 'check_blackboard':
      return {
        id: `act_${agentId}_${step}`,
        agentId,
        timestamp: ts,
        type: 'check_blackboard',
        summary: `Queried shared memory key swarm.contracts.v1`,
        blackboardNote: {
          key: 'swarm.contracts.v1',
          value: JSON.stringify({ version: '1.2.0', activeLeaves: 12 }),
          author: 'architect_1',
        },
      };
    default:
      return {
        id: `act_${agentId}_${step}`,
        agentId,
        timestamp: ts,
        type,
        summary: `Executed operation ${type}`,
      };
  }
}
