import type { SwarmTreeNode } from '@/components/swarm/SwarmDecompositionTree';

/**
 * Idle preview graph for Decomposition Studio when no live session exists.
 * Mirrors real SwarmTreeNode shapes so the canvas can render immediately.
 */
export function buildDemoDagNodes(mission = 'Ship a focused feature end-to-end'): SwarmTreeNode[] {
  return [
    {
      id: 'demo-plan',
      parent_id: null,
      description: 'Scope the change and acceptance criteria',
      label: 'Plan',
      status: 'completed',
      type: 'area',
      depth: 0,
      agent_class: 'architect',
    },
    {
      id: 'demo-impl',
      parent_id: 'demo-plan',
      description: 'Implement the core path',
      label: 'Implement',
      status: 'executing',
      type: 'task',
      depth: 1,
      agent_class: 'coding',
      depends_on: ['demo-plan'],
    },
    {
      id: 'demo-tests',
      parent_id: 'demo-plan',
      description: 'Add focused regression coverage',
      label: 'Tests',
      status: 'pending',
      type: 'task',
      depth: 1,
      agent_class: 'qa',
      depends_on: ['demo-impl'],
    },
    {
      id: 'demo-review',
      parent_id: 'demo-impl',
      description: 'Verify edge cases and ship checklist',
      label: 'Review',
      status: 'ready',
      type: 'task',
      depth: 2,
      agent_class: 'validation',
      depends_on: ['demo-impl', 'demo-tests'],
    },
    {
      id: 'demo-fail',
      parent_id: 'demo-tests',
      description: 'Example failed leaf (preview only)',
      label: 'Flaky check',
      status: 'failed',
      type: 'task',
      depth: 2,
      agent_class: 'qa',
      depends_on: ['demo-tests'],
    },
  ].map((n) => ({
    ...n,
    // keep mission text available for the objective chip via description on root
    ...(n.id === 'demo-plan' ? { description: mission } : {}),
  }));
}
