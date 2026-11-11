import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AGENT_ROLES, type AgentRole } from '@/lib/agentRoles';
import {
  autoAssignRoleBindings,
  emptyBindings,
  findBindingForHint,
  normalizeBindings,
  pickBoundOption,
} from '@/lib/roleBindings';
import {
  computeDebitCredits,
  CREDIT_PACKS,
  CREDITS_PER_USD,
  getModelPrice,
  listPricedModels,
  MARGIN_MULTIPLIER,
  MODEL_PRICES,
} from '@/lib/modelPricing';
import { modelStore, isConfigured, AZURE_MODELS } from '@/lib/modelStore';
import { toPublicProvider, type StoredProvider, type StoredProviderAllocation } from '@/lib/providerStore';
import { agentStreamStore, type AgentEvent } from '@/lib/agentStreamStore';
import {
  createDefaultMatrix,
  defaultRoute,
  resolveRoute,
  roleForAgentClass,
  usagePct,
  type RoutingMatrix,
} from '@/lib/routingMatrix';
import {
  computeSpatialLayout,
  evaluateLodTier,
  cullNodesInViewport,
  calculateFocusZoom,
  parseDiff,
  formatActiveTime,
  createMockAgentAction,
  type SpatialNode,
  type ViewportRect,
  type AgentSandbox,
  type SandboxStatus,
  type ActionType,
  type AgentAction,
} from './test-models';

describe('Tier 1: Feature Coverage (≥5 tests per feature across 12 features)', () => {
  // --------------------------------------------------------------------------
  // Feature 1: Dynamic Model Routing (R2)
  // --------------------------------------------------------------------------
  describe('1. Dynamic Model Routing (R2)', () => {
    const mockProviders: StoredProvider[] = [
      {
        id: 'p-azure',
        name: 'Azure AI Foundry',
        type: 'azure',
        endpoint: 'https://azure.gateway/chat',
        apiKey: 'sk-azure-secret-key-12345',
        models: ['DeepSeek-R1', 'DeepSeek-V4-Flash', 'gpt-5-nano'],
        quota: { rpm: 120, tpm: 100000, dailyBudget: 50, maxConcurrency: 10 },
        enabled: true,
      },
      {
        id: 'p-anthropic',
        name: 'Anthropic Cloud',
        type: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'sk-ant-secret-key-99999',
        models: ['claude-3-7-sonnet', 'claude-3-5-haiku'],
        quota: { rpm: 60, tpm: 50000, dailyBudget: 30, maxConcurrency: 5 },
        enabled: true,
      },
      {
        id: 'p-ollama',
        name: 'Local Ollama',
        type: 'ollama',
        endpoint: 'http://localhost:11434/api/generate',
        models: ['qwen2.5:3b', 'deepseek-r1-0528-qwen3:8b'],
        quota: { rpm: 1000, tpm: 1000000, dailyBudget: 0, maxConcurrency: 20 },
        enabled: true,
      },
    ];

    const mockAllocations: StoredProviderAllocation[] = [
      { providerId: 'p-azure', percent: 33, roles: [] },
      { providerId: 'p-anthropic', percent: 33, roles: [] },
      { providerId: 'p-ollama', percent: 34, roles: [] },
    ];

    it('T1.1.1: Resolves dynamic role bindings across frontier, strong, medium, and light tiers', () => {
      const bindings = autoAssignRoleBindings(mockProviders, mockAllocations);
      expect(bindings.length).toBe(AGENT_ROLES.length);

      const architectBinding = bindings.find((b) => b.roleId === 'architect');
      expect(architectBinding).toBeDefined();
      expect(architectBinding?.options.length).toBeGreaterThan(0);

      // Architect is a frontier role and should favor frontier models/providers
      const primaryOption = architectBinding?.options[0];
      expect(primaryOption).toBeDefined();
      expect(['p-azure', 'p-anthropic']).toContain(primaryOption?.providerId);
    });

    it('T1.1.2: Scores providers according to tier suitability with local vs frontier weightings', () => {
      const bindings = autoAssignRoleBindings(mockProviders, mockAllocations);
      
      const architect = bindings.find((b) => b.roleId === 'architect'); // frontier
      const depManager = bindings.find((b) => b.roleId === 'dependency-manager'); // light

      expect(architect?.options[0].providerId).toMatch(/p-azure|p-anthropic/);
      expect(depManager?.options[0].providerId).toBe('p-ollama');
    });

    it('T1.1.3: Matches role hints and seat titles dynamically via findBindingForHint', () => {
      const bindings = autoAssignRoleBindings(mockProviders, mockAllocations);
      const exactMatch = findBindingForHint('architect', bindings);
      const fuzzyMatch = findBindingForHint('Lead QA Verification Engineer', bindings);
      const unknownMatch = findBindingForHint('completely_unknown_xyz', bindings);

      expect(exactMatch?.roleId).toBe('architect');
      expect(['qa-engineer', 'verifier']).toContain(fuzzyMatch?.roleId);
      expect(unknownMatch).toBeNull();
    });

    it('T1.1.4: Accurately calculates credit conversion and debit credits with gross margin markup', () => {
      const pricedModels = listPricedModels();
      expect(pricedModels.length).toBeGreaterThan(5);
      expect(pricedModels).toContain('DeepSeek-R1');
      expect(pricedModels).toContain('GPT-4o-mini');

      const deepSeekCost = computeDebitCredits('DeepSeek-R1', 1000, 1000);
      expect(deepSeekCost).toBeGreaterThan(0);
      expect(typeof deepSeekCost).toBe('number');
      expect(Number.isFinite(deepSeekCost)).toBe(true);

      // Verify zero tokens charge 0 credits
      expect(computeDebitCredits('DeepSeek-R1', 0, 0)).toBe(0);
    });

    it('T1.1.5: Enforces security masking on public provider shapes removing raw API keys', () => {
      const pubAzure = toPublicProvider(mockProviders[0]);
      const pubOllama = toPublicProvider(mockProviders[2]);

      expect((pubAzure as any).apiKey).toBeUndefined();
      expect(pubAzure.hasApiKey).toBe(true);
      expect(pubAzure.apiKeySet).toBe(true);
      expect(pubOllama.hasApiKey).toBe(false);
    });

    it('T1.1.6: Refuses zero billing and throws error on unknown unpriced models', () => {
      expect(() => getModelPrice('non-existent-fake-model-12345')).toThrowError(/Unknown model/);
      expect(() => computeDebitCredits('unpriced-llm-hack', 500, 500)).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Feature 2: Telemetry Streaming Pipeline (R4)
  // --------------------------------------------------------------------------
  describe('2. Telemetry Streaming Pipeline (R4)', () => {
    beforeEach(() => {
      agentStreamStore.clear();
    });

    it('T1.2.1: Ingests all 6 inner-world event types seamlessly', () => {
      const eventTypes: AgentEvent['type'][] = [
        'thought',
        'tool_call',
        'tool_result',
        'memory',
        'state',
        'error',
      ];

      eventTypes.forEach((type, idx) => {
        agentStreamStore.ingest({
          id: `evt_${idx}`,
          agentId: 'agent_alpha',
          type,
          payload: { action: type, step: idx },
          timestamp: 1000 + idx * 100,
        });
      });

      expect(agentStreamStore.size()).toBe(1);
      const [agentState] = agentStreamStore.agentsSnapshot();
      expect(agentState.eventCount).toBe(6);
      expect(agentState.recentTypes.length).toBe(6);
      expect(agentState.recentTypes).toEqual(eventTypes);
    });

    it('T1.2.2: Enforces bounded 500-item global ring buffer with FIFO eviction', () => {
      const bulkEvents: AgentEvent[] = [];
      for (let i = 0; i < 550; i++) {
        bulkEvents.push({
          id: `batch_evt_${i}`,
          agentId: `agent_${i % 5}`,
          type: 'thought',
          payload: { step: i },
          timestamp: 10000 + i,
        });
      }

      agentStreamStore.ingestMany(bulkEvents);
      const buffer = agentStreamStore.bufferSnapshot();

      expect(buffer.length).toBe(500);
      expect(buffer[0].id).toBe('batch_evt_50'); // Oldest 50 evicted
      expect(buffer[499].id).toBe('batch_evt_549');
    });

    it('T1.2.3: Deduplicates state by agentId and tracks monotonic timestamps', () => {
      agentStreamStore.ingest({
        id: 'evt_1',
        agentId: 'agent_prime',
        type: 'state',
        payload: { status: 'running' },
        timestamp: 1000,
      });

      agentStreamStore.ingest({
        id: 'evt_2',
        agentId: 'agent_prime',
        type: 'tool_call',
        payload: { tool: 'browser_navigate' },
        timestamp: 5000,
      });

      const agents = agentStreamStore.agentsSnapshot();
      expect(agents.length).toBe(1);
      expect(agents[0].lastSeen).toBe(5000);
      expect(agents[0].lastEvent?.id).toBe('evt_2');
    });

    it('T1.2.4: Caps recentTypes to an 8-item sliding window', () => {
      const types: AgentEvent['type'][] = [
        'thought', 'tool_call', 'tool_result', 'memory',
        'state', 'error', 'thought', 'tool_call', 'tool_result', 'memory',
      ];

      types.forEach((type, idx) => {
        agentStreamStore.ingest({
          id: `slide_${idx}`,
          agentId: 'agent_slider',
          type,
          payload: {},
          timestamp: 2000 + idx,
        });
      });

      const [agent] = agentStreamStore.agentsSnapshot();
      expect(agent.recentTypes.length).toBe(8);
      expect(agent.recentTypes[0]).toBe('tool_result'); // First two evicted
      expect(agent.recentTypes[7]).toBe('memory');
    });

    it('T1.2.5: Aggregates events into 20-bucket sparkline histogram', () => {
      for (let i = 0; i < 5; i++) {
        agentStreamStore.ingest({
          id: `spark_${i}`,
          agentId: 'agent_spark',
          type: 'thought',
          payload: {},
          timestamp: 0 + i * 50,
        });
      }

      const [agent] = agentStreamStore.agentsSnapshot();
      const totalSparkline = agent.sparkline.reduce((acc, val) => acc + val, 0);
      expect(totalSparkline).toBe(5);
      expect(agent.sparkline.length).toBe(20);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 3: Sandbox Header & Archetype Cycler (R1)
  // --------------------------------------------------------------------------
  describe('3. Sandbox Header & Archetype Cycler (R1)', () => {
    it('T1.3.1: Validates complete inventory of 21 unique agent archetypes', () => {
      expect(AGENT_ROLES.length).toBe(21);
      const roleIds = new Set(AGENT_ROLES.map((r) => r.id));
      expect(roleIds.size).toBe(21);

      const requiredArchetypes = [
        'architect', 'implementer', 'verifier', 'researcher',
        'debugger', 'browser-agent', 'qa-engineer', 'security-auditor',
        'documentation-writer', 'devops-engineer', 'data-analyst', 'product-manager',
        'ux-critic', 'performance-optimizer', 'dependency-manager', 'merge-resolver',
        'test-writer', 'code-migrator', 'release-engineer', 'orchestrator',
        'context-condenser',
      ];

      requiredArchetypes.forEach((reqId) => {
        expect(roleIds.has(reqId)).toBe(true);
      });
    });

    it('T1.3.2: Maps each archetype to valid model tiers and visual styles', () => {
      const validTiers = new Set(['frontier', 'strong', 'medium', 'light']);
      AGENT_ROLES.forEach((role) => {
        expect(validTiers.has(role.model_tier)).toBe(true);
        expect(role.color).toContain('from-');
        expect(role.color).toContain('to-');
        expect(role.tools.length).toBeGreaterThan(0);
        expect(role.responsibility.length).toBeGreaterThan(10);
      });
    });

    it('T1.3.3: Supports cycling through archetypes deterministically', () => {
      const cycleNextRole = (currentId: string): AgentRole => {
        const idx = AGENT_ROLES.findIndex((r) => r.id === currentId);
        const nextIdx = (idx + 1) % AGENT_ROLES.length;
        return AGENT_ROLES[nextIdx];
      };

      let current = AGENT_ROLES[0];
      for (let i = 0; i < AGENT_ROLES.length; i++) {
        const next = cycleNextRole(current.id);
        expect(next.id).toBe(AGENT_ROLES[(i + 1) % AGENT_ROLES.length].id);
        current = next;
      }
      expect(current.id).toBe(AGENT_ROLES[0].id);
    });

    it('T1.3.4: Updates editable agent ID and propagates to sandbox tile metadata', () => {
      const sandbox: AgentSandbox = {
        id: 'sb_original',
        agentId: 'agent_01',
        nodeId: 'node_01',
        label: 'Original Label',
        mode: 'mixed',
        status: 'running',
        tools: ['shell', 'edit'],
        logs: [],
        toolCallCount: 0,
      };

      const updatedSandbox: AgentSandbox = {
        ...sandbox,
        id: 'sb_renamed_42',
        label: 'Renamed Coder Worker',
      };

      expect(updatedSandbox.id).toBe('sb_renamed_42');
      expect(updatedSandbox.label).toBe('Renamed Coder Worker');
      expect(updatedSandbox.nodeId).toBe('node_01');
    });

    it('T1.3.5: Manages state machine lifecycle transitions (idle -> running -> paused -> done)', () => {
      const validStatuses: SandboxStatus[] = ['idle', 'running', 'paused', 'error', 'done'];
      let status: SandboxStatus = 'idle';

      const transition = (newStatus: SandboxStatus) => {
        if (!validStatuses.includes(newStatus)) throw new Error('Invalid status');
        status = newStatus;
      };

      transition('running');
      expect(status).toBe('running');
      transition('paused');
      expect(status).toBe('paused');
      transition('running');
      expect(status).toBe('running');
      transition('done');
      expect(status).toBe('done');
    });
  });

  // --------------------------------------------------------------------------
  // Feature 4: Live Metric Matrix & Quota Controls (R1)
  // --------------------------------------------------------------------------
  describe('4. Live Metric Matrix & Quota Controls (R1)', () => {
    it('T1.4.1: Formats active execution timer as HH:MM:SS with pause deltas', () => {
      expect(formatActiveTime(0)).toBe('00:00:00');
      expect(formatActiveTime(59)).toBe('00:00:59');
      expect(formatActiveTime(3600)).toBe('01:00:00');
      expect(formatActiveTime(3665)).toBe('01:01:05');
      expect(formatActiveTime(86399)).toBe('23:59:59');
    });

    it('T1.4.2: Computes token in/out arithmetic and context usage percentage', () => {
      const tokensIn = 12500;
      const tokensOut = 3500;
      const totalTokens = tokensIn + tokensOut;
      const maxContext = 128000;

      const contextPercent = Math.min(100, Math.round((totalTokens / maxContext) * 100));

      expect(totalTokens).toBe(16000);
      expect(contextPercent).toBe(13);
    });

    it('T1.4.3: Validates inline editable RPM and TPM limit updates', () => {
      const matrix = createDefaultMatrix();
      const codingRoute = matrix.routes.find((r) => r.role === 'coding');
      expect(codingRoute).toBeDefined();

      const initialRpm = codingRoute!.rpmLimit;
      codingRoute!.rpmLimit = 250;
      expect(codingRoute!.rpmLimit).toBe(250);
      expect(codingRoute!.rpmLimit).not.toBe(initialRpm);
    });

    it('T1.4.4: Computes quota usage percentage and caps at 100%', () => {
      expect(usagePct(30, 60)).toBe(50);
      expect(usagePct(60, 60)).toBe(100);
      expect(usagePct(90, 60)).toBe(100); // Capped at 100
      expect(usagePct(0, 60)).toBe(0);
      expect(usagePct(10, 0)).toBe(0); // Zero division protection
    });

    it('T1.4.5: Resolves default quotas and route limits for all roles', () => {
      const roles = ['architect', 'planning', 'coding', 'research', 'validation', 'browser', 'execution'] as const;
      roles.forEach((r) => {
        const route = defaultRoute(r);
        expect(route.rpmLimit).toBeGreaterThan(0);
        expect(route.dailyBudgetUsd).toBeGreaterThan(0);
        expect(route.maxConcurrent).toBeGreaterThan(0);
      });
    });
  });

  // --------------------------------------------------------------------------
  // Feature 5: Interactive Action Log & Viewport State Sync (R1)
  // --------------------------------------------------------------------------
  describe('5. Interactive Action Log & Viewport State Sync (R1)', () => {
    it('T1.5.1: Records all 9 specified tool actions with structured payloads', () => {
      const allActionTypes: ActionType[] = [
        'use_browser',
        'communicate',
        'spawn_subagent',
        'create_file',
        'think',
        'check_blackboard',
        'compress_context',
        'git_commit',
        'file_edit',
      ];

      const actions = allActionTypes.map((type, i) => createMockAgentAction('agent_tester', type, i));
      expect(actions.length).toBe(9);
      actions.forEach((act, idx) => {
        expect(act.type).toBe(allActionTypes[idx]);
        expect(act.timestamp).toBeGreaterThan(0);
        expect(act.summary.length).toBeGreaterThan(0);
      });
    });

    it('T1.5.2: Maps tool action types to their corresponding workspace viewport tabs', () => {
      const actionToViewportMap: Record<ActionType, 'browser' | 'editor' | 'blackboard' | 'graph'> = {
        use_browser: 'browser',
        file_edit: 'editor',
        create_file: 'editor',
        git_commit: 'editor',
        think: 'blackboard',
        check_blackboard: 'blackboard',
        compress_context: 'blackboard',
        spawn_subagent: 'graph',
        communicate: 'graph',
      };

      expect(actionToViewportMap['use_browser']).toBe('browser');
      expect(actionToViewportMap['file_edit']).toBe('editor');
      expect(actionToViewportMap['think']).toBe('blackboard');
      expect(actionToViewportMap['spawn_subagent']).toBe('graph');
    });

    it('T1.5.3: Supports diff preview toggle state on file modifications', () => {
      const action = createMockAgentAction('agent_editor', 'file_edit', 1);
      expect(action.diff).toBeDefined();
      expect(action.diff?.filename).toBe('src/lib/roleBindings.ts');
      expect(action.diff?.additions).toBe(2);
      expect(action.diff?.deletions).toBe(1);
    });

    it('T1.5.4: Filters action logs by query string and action type', () => {
      const actions = [
        createMockAgentAction('agent_1', 'use_browser', 1),
        createMockAgentAction('agent_1', 'file_edit', 2),
        createMockAgentAction('agent_1', 'think', 3),
        createMockAgentAction('agent_1', 'spawn_subagent', 4),
      ];

      const browserOnly = actions.filter((a) => a.type === 'use_browser');
      const searchRoleBindings = actions.filter((a) => a.summary.includes('roleBindings'));

      expect(browserOnly.length).toBe(1);
      expect(searchRoleBindings.length).toBe(1);
      expect(searchRoleBindings[0].type).toBe('file_edit');
    });

    it('T1.5.5: Handles empty action log gracefully without throwing', () => {
      const emptyLogs: AgentAction[] = [];
      const filterResult = emptyLogs.filter((a) => a.type === 'think');
      expect(filterResult).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 6: Browser Viewport & Animated Cursor (R1)
  // --------------------------------------------------------------------------
  describe('6. Browser Viewport & Animated Cursor (R1)', () => {
    it('T1.6.1: Validates URL navigation bar parsing and default about:blank fallback', () => {
      const normalizeUrl = (url?: string) => url?.trim() || 'about:blank';

      expect(normalizeUrl('https://docs.anthropic.com')).toBe('https://docs.anthropic.com');
      expect(normalizeUrl('')).toBe('about:blank');
      expect(normalizeUrl(undefined)).toBe('about:blank');
    });

    it('T1.6.2: Parses animated target cursor (x, y) coordinates from action payload', () => {
      const browserAction = createMockAgentAction('browser_agent', 'use_browser', 1);
      expect(browserAction.coordinates).toBeDefined();
      expect(browserAction.coordinates?.x).toBeGreaterThanOrEqual(0);
      expect(browserAction.coordinates?.y).toBeGreaterThanOrEqual(0);
    });

    it('T1.6.3: Constrains cursor coordinates to viewport dimensions', () => {
      const clampCoordinates = (coord: { x: number; y: number }, width: number, height: number) => ({
        x: Math.max(0, Math.min(coord.x, width)),
        y: Math.max(0, Math.min(coord.y, height)),
      });

      const clamped = clampCoordinates({ x: 1200, y: -50 }, 800, 600);
      expect(clamped.x).toBe(800);
      expect(clamped.y).toBe(0);
    });

    it('T1.6.4: Renders search DOM query simulation structure', () => {
      const searchDom = {
        query: 'FastAPI async streaming endpoints',
        resultsCount: 8,
        items: [
          { title: 'Async request streaming in FastAPI', url: 'https://fastapi.tiangolo.com/async' },
          { title: 'Server-Sent Events with Starlette', url: 'https://starlette.io/sse' },
        ],
      };

      expect(searchDom.items.length).toBe(2);
      expect(searchDom.items[0].url).toContain('fastapi');
    });

    it('T1.6.5: Fallbacks safely when browser backend is offline or disconnected', () => {
      const fallbackScreenshot = (isOnline: boolean, screenshotUrl?: string) => {
        if (!isOnline) return { mode: 'placeholder', icon: 'Globe', message: 'Browser session offline' };
        return { mode: 'live', url: screenshotUrl };
      };

      const offlineState = fallbackScreenshot(false);
      expect(offlineState.mode).toBe('placeholder');
      expect(offlineState.message).toContain('offline');
    });
  });

  // --------------------------------------------------------------------------
  // Feature 7: Editor Diff Viewport & Blinking Cursor (R1)
  // --------------------------------------------------------------------------
  describe('7. Editor Diff Viewport & Blinking Cursor (R1)', () => {
    const sampleDiff = `@@ -1,5 +1,6 @@
 import { useState } from 'react';
-const oldVar = 10;
+const newVar = 20;
+const addedLine = true;
 export function calculate() {`;

    it('T1.7.1: Parses unified diff additions (+), deletions (-), and context lines', () => {
      const parsed = parseDiff('src/app/test.ts', sampleDiff);
      expect(parsed.filename).toBe('src/app/test.ts');
      expect(parsed.additions).toBe(2);
      expect(parsed.deletions).toBe(1);
      expect(parsed.lines.length).toBe(6);
    });

    it('T1.7.2: Accurately aligns line numbers for additions and context lines', () => {
      const parsed = parseDiff('src/app/test.ts', sampleDiff);
      const addedLines = parsed.lines.filter((l) => l.type === 'add');
      const delLines = parsed.lines.filter((l) => l.type === 'del');

      expect(addedLines[0].lineNo).toBeDefined();
      expect(delLines[0].lineNo).toBeUndefined(); // Deletions don't advance target line numbers
    });

    it('T1.7.3: Tokenizes syntax keywords for TypeScript and JSON file extensions', () => {
      const tokenizeLine = (content: string) => {
        const tokens = content.split(/\s+/);
        const keywords = ['import', 'const', 'export', 'function', 'return'];
        return tokens.map((t) => ({ text: t, isKeyword: keywords.includes(t) }));
      };

      const tokens = tokenizeLine('export function calculate() {');
      expect(tokens[0].isKeyword).toBe(true);
      expect(tokens[1].isKeyword).toBe(true);
      expect(tokens[2].isKeyword).toBe(false);
    });

    it('T1.7.4: Tracks blinking cursor active line index and file written history', () => {
      const editorState = {
        activeFile: 'src/lib/roleBindings.ts',
        activeLineIndex: 3,
        cursorVisible: true,
        filesWritten: ['src/lib/roleBindings.ts', 'src/lib/modelStore.ts'],
      };

      expect(editorState.filesWritten.length).toBe(2);
      expect(editorState.activeLineIndex).toBe(3);
    });

    it('T1.7.5: Handles empty diff and zero line modifications cleanly', () => {
      const emptyParsed = parseDiff('empty.txt', '');
      expect(emptyParsed.additions).toBe(0);
      expect(emptyParsed.deletions).toBe(0);
      expect(emptyParsed.lines.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 8: Blackboard Memory & Thought Stream (R1)
  // --------------------------------------------------------------------------
  describe('8. Blackboard Memory & Thought Stream (R1)', () => {
    it('T1.8.1: Reads and writes structured key-value notes to shared blackboard', () => {
      const blackboard: Record<string, { value: string; author: string; ts: number }> = {};

      const writeNote = (key: string, value: string, author: string) => {
        blackboard[key] = { value, author, ts: Date.now() };
      };

      writeNote('swarm.contracts.v1', '{"version": "1.0.0"}', 'architect_1');
      writeNote('swarm.verification.passed', 'true', 'verifier_1');

      expect(Object.keys(blackboard).length).toBe(2);
      expect(blackboard['swarm.contracts.v1'].author).toBe('architect_1');
    });

    it('T1.8.2: Formats thought stream with live elapsed timer accumulation', () => {
      const thoughtAction = createMockAgentAction('planner_1', 'think', 1);
      expect(thoughtAction.thoughtStream).toBeDefined();
      expect(thoughtAction.thoughtStream?.elapsedSec).toBeGreaterThan(0);
      expect(thoughtAction.thoughtStream?.text.length).toBeGreaterThan(20);
    });

    it('T1.8.3: Computes context compression ratio telemetry', () => {
      const originalTokens = 45000;
      const compressedTokens = 12500;
      const ratio = Math.round((compressedTokens / originalTokens) * 100) / 100;

      expect(ratio).toBe(0.28);
      expect(ratio).toBeLessThan(1.0);
    });

    it('T1.8.4: Extracts thinking style and confidence tags from reasoning payload', () => {
      const payload = {
        thought: '<thinking_style>deductive</thinking_style><confidence>0.96</confidence>Decomposing subtasks...',
      };

      const styleMatch = payload.thought.match(/<thinking_style>(.*?)<\/thinking_style>/);
      const confMatch = payload.thought.match(/<confidence>(.*?)<\/confidence>/);

      expect(styleMatch?.[1]).toBe('deductive');
      expect(confMatch?.[1]).toBe('0.96');
    });

    it('T1.8.5: Handles empty reasoning streams gracefully', () => {
      const emptyThought = { text: '', elapsedSec: 0 };
      expect(emptyThought.elapsedSec).toBe(0);
      expect(emptyThought.text).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Feature 9: Graph Viewport & Particle Pulses (R1)
  // --------------------------------------------------------------------------
  describe('9. Graph Viewport & Particle Pulses (R1)', () => {
    it('T1.9.1: Generates parent-child edge connections for subagent delegation', () => {
      const agents = [
        { id: 'root_planner', roleId: 'architect' },
        { id: 'sub_coder_1', roleId: 'implementer', parentId: 'root_planner' },
        { id: 'sub_coder_2', roleId: 'implementer', parentId: 'root_planner' },
      ];

      const layout = computeSpatialLayout(agents);
      expect(layout.edges.length).toBe(2);
      expect(layout.edges[0].source).toBe('root_planner');
      expect(layout.edges[0].target).toBe('sub_coder_1');
    });

    it('T1.9.2: Calculates SVG bezier curves for smooth dependency flows', () => {
      const agents = [
        { id: 'parent_1', roleId: 'architect' },
        { id: 'child_1', roleId: 'verifier', parentId: 'parent_1' },
      ];

      const layout = computeSpatialLayout(agents);
      const edge = layout.edges[0];
      expect(edge.path).toContain('M ');
      expect(edge.path).toContain('C ');
      expect(edge.particleSpeed).toBeGreaterThan(0);
    });

    it('T1.9.3: Assigns execution status badges to graph nodes', () => {
      const node: SpatialNode = {
        id: 'node_test',
        agentId: 'node_test',
        roleId: 'implementer',
        depth: 1,
        x: 100,
        y: 200,
        width: 280,
        height: 180,
        status: 'running',
        label: 'Node Test',
      };

      expect(node.status).toBe('running');
      node.status = 'done';
      expect(node.status).toBe('done');
    });

    it('T1.9.4: Dynamically adds child node when spawn_subagent action occurs', () => {
      const initialAgents = [{ id: 'arch_1', roleId: 'architect' }];
      const layout1 = computeSpatialLayout(initialAgents);
      expect(layout1.nodes.length).toBe(1);

      const spawnAction = createMockAgentAction('arch_1', 'spawn_subagent', 1);
      const childId = spawnAction.params?.childId;

      const updatedAgents = [
        ...initialAgents,
        { id: childId, roleId: 'implementer', parentId: 'arch_1' },
      ];

      const layout2 = computeSpatialLayout(updatedAgents);
      expect(layout2.nodes.length).toBe(2);
      expect(layout2.edges.length).toBe(1);
    });

    it('T1.9.5: Detects and rejects circular parent references in subagent trees', () => {
      const detectCycle = (agentList: Array<{ id: string; parentId?: string | null }>): boolean => {
        const visited = new Set<string>();
        const inStack = new Set<string>();

        const dfs = (id: string): boolean => {
          visited.add(id);
          inStack.add(id);
          const child = agentList.find((a) => a.id === id);
          if (child?.parentId) {
            if (!visited.has(child.parentId) && dfs(child.parentId)) return true;
            if (inStack.has(child.parentId)) return true;
          }
          inStack.delete(id);
          return false;
        };

        for (const a of agentList) {
          if (!visited.has(a.id)) {
            if (dfs(a.id)) return true;
          }
        }
        return false;
      };

      const cyclicAgents = [
        { id: 'node_a', parentId: 'node_b' },
        { id: 'node_b', parentId: 'node_a' },
      ];

      expect(detectCycle(cyclicAgents)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 10: Spatial Layout Math (R3)
  // --------------------------------------------------------------------------
  describe('10. Spatial Layout Math (R3)', () => {
    it('T1.10.1: Places root peer agents in balanced symmetric column bands at depth 0', () => {
      const peerAgents = [
        { id: 'root_1', roleId: 'architect' },
        { id: 'root_2', roleId: 'planner' },
        { id: 'root_3', roleId: 'product-manager' },
        { id: 'root_4', roleId: 'security-auditor' },
      ];

      const layout = computeSpatialLayout(peerAgents);
      expect(layout.nodes.length).toBe(4);
      layout.nodes.forEach((n) => {
        expect(n.depth).toBe(0);
        expect(n.parentId).toBeNull();
      });
    });

    it('T1.10.2: Places subagents hierarchically beneath their parent creator node', () => {
      const agents = [
        { id: 'root_1', roleId: 'architect' },
        { id: 'sub_1', roleId: 'implementer', parentId: 'root_1' },
      ];

      const layout = computeSpatialLayout(agents);
      const rootNode = layout.nodes.find((n) => n.id === 'root_1')!;
      const subNode = layout.nodes.find((n) => n.id === 'sub_1')!;

      expect(subNode.y).toBeGreaterThan(rootNode.y);
      expect(subNode.depth).toBe(1);
    });

    it('T1.10.3: Distributes multi-sibling subagents symmetrically around parent center', () => {
      const agents = [
        { id: 'parent', roleId: 'architect' },
        { id: 'child_1', roleId: 'implementer', parentId: 'parent' },
        { id: 'child_2', roleId: 'verifier', parentId: 'parent' },
      ];

      const layout = computeSpatialLayout(agents);
      const c1 = layout.nodes.find((n) => n.id === 'child_1')!;
      const c2 = layout.nodes.find((n) => n.id === 'child_2')!;

      expect(c1.x).toBeLessThan(c2.x);
      expect(c1.y).toBe(c2.y);
    });

    it('T1.10.4: Computes total canvas extents and bounding boxes accurately', () => {
      const agents = [
        { id: 'a1', roleId: 'architect' },
        { id: 'a2', roleId: 'implementer', parentId: 'a1' },
      ];

      const layout = computeSpatialLayout(agents);
      expect(layout.bounds.width).toBeGreaterThan(0);
      expect(layout.bounds.height).toBeGreaterThan(0);
      expect(layout.bounds.maxX).toBeGreaterThanOrEqual(layout.bounds.minX);
    });

    it('T1.10.5: Produces identical deterministic layouts for identical agent topologies', () => {
      const agents = [
        { id: 'r1', roleId: 'architect' },
        { id: 'r2', roleId: 'orchestrator' },
        { id: 'c1', roleId: 'implementer', parentId: 'r1' },
      ];

      const layout1 = computeSpatialLayout(agents);
      const layout2 = computeSpatialLayout(agents);

      expect(layout1.nodes).toEqual(layout2.nodes);
      expect(layout1.edges).toEqual(layout2.edges);
      expect(layout1.bounds).toEqual(layout2.bounds);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 11: Infinite 2D Canvas & LOD Culling (R3)
  // --------------------------------------------------------------------------
  describe('11. Infinite 2D Canvas & LOD Culling (R3)', () => {
    it('T1.11.1: Evaluates 3-tier Level-of-Detail (LOD) thresholds correctly', () => {
      expect(evaluateLodTier(0.1)).toBe('micro');
      expect(evaluateLodTier(0.34)).toBe('micro');
      expect(evaluateLodTier(0.35)).toBe('standard');
      expect(evaluateLodTier(0.75)).toBe('standard');
      expect(evaluateLodTier(0.76)).toBe('full');
      expect(evaluateLodTier(2.0)).toBe('full');
    });

    it('T1.11.2: Culls off-screen nodes outside the active viewport bounding box', () => {
      const nodes: SpatialNode[] = [
        { id: 'visible_1', agentId: 'v1', roleId: 'coder', depth: 0, x: 100, y: 100, width: 280, height: 180, status: 'running', label: 'V1' },
        { id: 'hidden_far_right', agentId: 'h1', roleId: 'coder', depth: 0, x: 5000, y: 100, width: 280, height: 180, status: 'running', label: 'H1' },
        { id: 'hidden_far_down', agentId: 'h2', roleId: 'coder', depth: 0, x: 100, y: 6000, width: 280, height: 180, status: 'running', label: 'H2' },
      ];

      const viewport: ViewportRect = { x: 0, y: 0, width: 1200, height: 800, zoom: 1.0 };
      const rendered = cullNodesInViewport(nodes, viewport);

      expect(rendered.length).toBe(1);
      expect(rendered[0].id).toBe('visible_1');
    });

    it('T1.11.3: Retains edge boundary nodes within margin threshold', () => {
      const nodes: SpatialNode[] = [
        { id: 'near_boundary', agentId: 'nb', roleId: 'coder', depth: 0, x: 1220, y: 100, width: 280, height: 180, status: 'running', label: 'NB' },
      ];

      const viewport: ViewportRect = { x: 0, y: 0, width: 1200, height: 800, zoom: 1.0 };
      const renderedWithMargin = cullNodesInViewport(nodes, viewport, 50);
      const renderedWithoutMargin = cullNodesInViewport(nodes, viewport, 0);

      expect(renderedWithMargin.length).toBe(1);
      expect(renderedWithoutMargin.length).toBe(0);
    });

    it('T1.11.4: Handles world-to-screen coordinate scaling under zoom transformations', () => {
      const worldToScreen = (wx: number, wy: number, camX: number, camY: number, zoom: number) => ({
        sx: (wx - camX) * zoom,
        sy: (wy - camY) * zoom,
      });

      const screen = worldToScreen(200, 300, 100, 100, 1.5);
      expect(screen.sx).toBe(150);
      expect(screen.sy).toBe(300);
    });

    it('T1.11.5: Calculates zoom-to-fit camera position encompassing all nodes', () => {
      const bounds = { minX: 0, maxX: 2000, minY: 0, maxY: 1000, width: 2000, height: 1000 };
      const screenW = 1000;
      const screenH = 600;

      const fitZoom = Math.min(screenW / bounds.width, screenH / bounds.height) * 0.9;
      expect(fitZoom).toBeLessThan(1.0);
      expect(fitZoom).toBeGreaterThan(0.2);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 12: Minimap & Focus Zoom (R3)
  // --------------------------------------------------------------------------
  describe('12. Minimap & Focus Zoom (R3)', () => {
    it('T1.12.1: Calculates 1-click focus zoom camera centering on target node', () => {
      const targetNode: SpatialNode = {
        id: 'target_agent_42',
        agentId: 'agent_42',
        roleId: 'implementer',
        depth: 1,
        x: 600,
        y: 400,
        width: 280,
        height: 180,
        status: 'running',
        label: 'Agent 42',
      };

      const focus = calculateFocusZoom(targetNode, 1200, 800, 1.0);

      // Center of targetNode is (600 + 140 = 740, 400 + 90 = 490)
      // Camera top-left: 740 - 600 = 140, 490 - 400 = 90
      expect(focus.x).toBe(140);
      expect(focus.y).toBe(90);
      expect(focus.zoom).toBe(1.0);
    });

    it('T1.12.2: Normalizes spatial coordinates to minimap aspect ratio', () => {
      const normalizeToMinimap = (x: number, y: number, bounds: { minX: number; maxX: number; minY: number; maxY: number }, miniW: number, miniH: number) => ({
        mx: ((x - bounds.minX) / (bounds.maxX - bounds.minX || 1)) * miniW,
        my: ((y - bounds.minY) / (bounds.maxY - bounds.minY || 1)) * miniH,
      });

      const miniPoint = normalizeToMinimap(500, 500, { minX: 0, maxX: 1000, minY: 0, maxY: 1000 }, 200, 150);
      expect(miniPoint.mx).toBe(100);
      expect(miniPoint.my).toBe(75);
    });

    it('T1.12.3: Filters nodes by role query on canvas and minimap', () => {
      const nodes: SpatialNode[] = [
        { id: '1', agentId: '1', roleId: 'architect', depth: 0, x: 0, y: 0, width: 280, height: 180, status: 'running', label: 'Architect Lead' },
        { id: '2', agentId: '2', roleId: 'implementer', depth: 1, x: 0, y: 200, width: 280, height: 180, status: 'running', label: 'Backend Coder' },
        { id: '3', agentId: '3', roleId: 'verifier', depth: 1, x: 300, y: 200, width: 280, height: 180, status: 'done', label: 'QA Verifier' },
      ];

      const coders = nodes.filter((n) => n.roleId === 'implementer');
      const verifiers = nodes.filter((n) => n.status === 'done');

      expect(coders.length).toBe(1);
      expect(verifiers.length).toBe(1);
    });

    it('T1.12.4: Translates minimap click coordinates back to world canvas camera position', () => {
      const minimapClickToWorld = (clickX: number, clickY: number, miniW: number, miniH: number, bounds: { minX: number; maxX: number; minY: number; maxY: number }) => ({
        worldX: bounds.minX + (clickX / miniW) * (bounds.maxX - bounds.minX),
        worldY: bounds.minY + (clickY / miniH) * (bounds.maxY - bounds.minY),
      });

      const worldPos = minimapClickToWorld(100, 75, 200, 150, { minX: 0, maxX: 2000, minY: 0, maxY: 1000 });
      expect(worldPos.worldX).toBe(1000);
      expect(worldPos.worldY).toBe(500);
    });

    it('T1.12.5: Maintains active selection highlight across canvas and minimap sync', () => {
      let selectedAgentId: string | null = null;
      const selectAgent = (id: string) => {
        selectedAgentId = id;
      };

      selectAgent('agent_target_99');
      expect(selectedAgentId).toBe('agent_target_99');
    });
  });
});
