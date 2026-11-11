// Relentless Agent Execution Engine
// Core loop: plan → act → verify → diagnose → retry
// Never gives up until task is done or genuinely blocked

import { gatewayChatUrl } from './providerRouter';

// All LLM traffic goes through the engine gateway (Azure AI Foundry).
// The gateway injects credentials server-side; the browser never holds a key.
const CHAT_ENDPOINT = gatewayChatUrl();
const CHAT_MODEL =
  process.env.NEXT_PUBLIC_ENGINE_CHAT_MODEL ||
  'DeepSeek-V4-Flash';

// ─── Types ──────────────────────────────────────────────────────────

export type ToolName =
  | 'think'
  | 'shell_exec'
  | 'file_write'
  | 'file_read'
  | 'file_list'
  | 'web_search'
  | 'browse_url'
  | 'code_generate'
  | 'task_complete'
  | 'task_blocked'
  // ── Hamiltonian MCP — enabled by default for all agents ──────────────────
  | 'hamiltonian_decide'
  | 'hamiltonian_rank_actions'
  | 'hamiltonian_feedback';

export interface ToolCall {
  tool: ToolName;
  params: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  duration_ms: number;
}

export interface ExecutionStep {
  step: number;
  phase: 'plan' | 'act' | 'verify' | 'diagnose' | 'retry';
  tool?: ToolName;
  reasoning?: string;
  result?: ToolResult;
  timestamp: number;
}

export interface ExecutionState {
  taskId: string;
  task: string;
  context: string;
  status: 'running' | 'completed' | 'failed' | 'blocked';
  steps: ExecutionStep[];
  retryCount: number;
  maxRetries: number;
  startedAt: number;
  completedAt?: number;
  finalResult?: string;
  error?: string;
}

export type StepCallback = (step: ExecutionStep, state: ExecutionState) => void;

// ─── Tool Implementations ───────────────────────────────────────────

const TOOL_SCHEMA = [
  {
    name: 'think',
    description: 'Reason about the current state, plan next steps, or diagnose a failure. Use this before acting.',
    params: { reasoning: 'string — your chain-of-thought analysis' },
  },
  {
    name: 'shell_exec',
    description: 'Execute a shell command. Use for: running builds, installing packages, running tests, checking file system.',
    params: { command: 'string — the shell command to run', cwd: 'string? — working directory (default: project root)' },
  },
  {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories if needed.',
    params: { path: 'string — file path relative to project root', content: 'string — complete file content' },
  },
  {
    name: 'file_read',
    description: 'Read a file\'s content.',
    params: { path: 'string — file path relative to project root' },
  },
  {
    name: 'file_list',
    description: 'List files in a directory.',
    params: { path: 'string — directory path', recursive: 'boolean? — recurse into subdirs (default false)' },
  },
  {
    name: 'web_search',
    description: 'Search the web for information. Returns top results with titles, URLs, and snippets.',
    params: { query: 'string — search query' },
  },
  {
    name: 'browse_url',
    description: 'Fetch and extract text content from a URL.',
    params: { url: 'string — the URL to browse' },
  },
  {
    name: 'code_generate',
    description: 'Generate code for a specific purpose. The LLM writes the code, you verify it works.',
    params: { language: 'string', purpose: 'string — what the code should do', context: 'string? — existing code or constraints' },
  },
  {
    name: 'task_complete',
    description: 'Mark the current task as successfully completed. Only use when you have VERIFIED the result.',
    params: { result: 'string — summary of what was accomplished', evidence: 'string? — proof it works (test output, file contents, etc.)' },
  },
  {
    name: 'task_blocked',
    description: 'Mark the task as blocked. Only use after exhausting ALL retry attempts and alternatives.',
    params: { reason: 'string — why the task cannot proceed', attempted: 'string — what was tried' },
  },
  // ── Hamiltonian MCP — default-enabled for ALL agents ──────────────────────
  {
    name: 'hamiltonian_decide',
    description: 'Query the Hamiltonian Quantum Reservoir Computing oracle for the minimum-energy optimal next action. Call this at the START of each step to get the best action to take next. Returns optimal_action, confidence score, and full trajectory plan.',
    params: {
      task_id:              'string — unique task/subtask identifier',
      task_label:           'string — human-readable task title',
      step_index:           'number — current step index (0-based)',
      max_steps:            'number — total step budget',
      task_description:     'string? — detailed task description',
      acceptance_met_ratio: 'number? — fraction of acceptance criteria satisfied (0.0–1.0)',
      last_action:          'string? — the action executed in the previous step',
      last_success:         'boolean? — whether the previous action succeeded',
      priority:             'number? — task priority 1–10',
      time_remaining_sec:   'number? — seconds left in project time budget',
    },
  },
  {
    name: 'hamiltonian_rank_actions',
    description: 'Rank a list of candidate tool actions by lowest energy delta (steepest descent toward goal). Use when you have multiple valid next steps and need to pick the optimal one.',
    params: {
      task_goal:             'string — the overall objective or acceptance criteria',
      candidate_actions:     'array — list of {action: string, description?: string} objects to rank',
      current_state_summary: 'string? — brief summary of current project state',
    },
  },
  {
    name: 'hamiltonian_feedback',
    description: 'Feed step outcome reward back into the Hamiltonian state matrix to reinforce successful trajectories. Call after each completed action with reward=1.0 for success, 0.0 for failure.',
    params: {
      task_id:    'string — task identifier',
      action:     'string — the action that was executed',
      reward:     'number — outcome reward: 1.0=clean success, 0.5=partial, 0.0=failure',
      step_index: 'number? — step index that completed',
    },
  },
];

async function executeTool(tool: ToolName, params: Record<string, unknown>): Promise<ToolResult> {
  const start = Date.now();

  try {
    switch (tool) {
      case 'think':
        return { success: true, output: String(params.reasoning || ''), duration_ms: Date.now() - start };

      case 'shell_exec': {
        const { execSync } = await import('child_process');
        const cmd = String(params.command || '');
        const cwd = String(params.cwd || process.cwd());
        try {
          const out = execSync(cmd, {
            cwd,
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { success: true, output: out.slice(0, 8000), duration_ms: Date.now() - start };
        } catch (e: any) {
          const stderr = e.stderr ? String(e.stderr).slice(0, 4000) : '';
          const stdout = e.stdout ? String(e.stdout).slice(0, 4000) : '';
          return {
            success: false,
            output: stdout,
            error: `Exit code ${e.status}: ${stderr || e.message}`,
            duration_ms: Date.now() - start,
          };
        }
      }

      case 'file_write': {
        const fs = await import('fs');
        const path = await import('path');
        const filePath = String(params.path || '');
        const content = String(params.content || '');
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true, output: `Wrote ${content.length} bytes to ${filePath}`, duration_ms: Date.now() - start };
      }

      case 'file_read': {
        const fs = await import('fs');
        const filePath = String(params.path || '');
        if (!fs.existsSync(filePath)) {
          return { success: false, output: '', error: `File not found: ${filePath}`, duration_ms: Date.now() - start };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, output: content.slice(0, 10000), duration_ms: Date.now() - start };
      }

      case 'file_list': {
        const fs = await import('fs');
        const filePath = String(params.path || '.');
        if (!fs.existsSync(filePath)) {
          return { success: false, output: '', error: `Directory not found: ${filePath}`, duration_ms: Date.now() - start };
        }
        const entries = fs.readdirSync(filePath, { withFileTypes: true });
        const list = entries.map(e => `${e.isDirectory() ? '[dir] ' : ''}${e.name}`).join('\n');
        return { success: true, output: list, duration_ms: Date.now() - start };
      }

      case 'web_search': {
        const query = String(params.query || '');
        // Use DeepSeek to simulate web research (real integration would use SerpAPI/Brave)
        const research = await callLLM(
          'You are a research assistant. Given a search query, provide a comprehensive summary of what you know about this topic. Include specific facts, numbers, URLs if known, and actionable insights.',
          `Search query: ${query}\n\nProvide a research summary with key findings, relevant URLs, and actionable insights.`,
          1024,
        );
        return { success: true, output: research.slice(0, 5000), duration_ms: Date.now() - start };
      }

      case 'browse_url': {
        const url = String(params.url || '');
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 15000);
          const r = await fetch(url, {
            signal: ctl.signal,
            headers: { 'User-Agent': 'SwarmAgents/1.0' },
          });
          clearTimeout(t);
          const text = await r.text();
          // Strip HTML tags for readable content
          const clean = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          return { success: true, output: clean.slice(0, 8000), duration_ms: Date.now() - start };
        } catch (e: any) {
          return { success: false, output: '', error: `Browse failed: ${e.message}`, duration_ms: Date.now() - start };
        }
      }

      case 'code_generate': {
        const language = String(params.language || 'typescript');
        const purpose = String(params.purpose || '');
        const context = String(params.context || '');
        const code = await callLLM(
          `You are an expert ${language} developer. Write clean, production-ready code. Output ONLY the code, no explanations.`,
          `Purpose: ${purpose}\n${context ? `Context:\n${context}` : ''}`,
          4096,
        );
        return { success: true, output: code, duration_ms: Date.now() - start };
      }

      case 'task_complete':
        return {
          success: true,
          output: `TASK_COMPLETE: ${String(params.result || 'Done')}`,
          duration_ms: Date.now() - start,
        };

      case 'task_blocked':
        return {
          success: false,
          output: `TASK_BLOCKED: ${String(params.reason || 'Unknown')}`,
          error: `Blocked: ${String(params.reason || 'Unknown')}. Attempted: ${String(params.attempted || 'N/A')}`,
          duration_ms: Date.now() - start,
        };

      // ── Hamiltonian MCP tools ────────────────────────────────────────────
      case 'hamiltonian_decide': {
        // Calls /api/hamiltonian/decide which has engine proxy + local QRC fallback.
        // Uses internal fetch (server-side) — no browser CORS concerns.
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
        try {
          const res = await fetch(`${baseUrl}/api/hamiltonian/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task_id:              String(params.task_id || 'unknown'),
              task_label:           String(params.task_label || 'task'),
              task_description:     params.task_description ? String(params.task_description) : undefined,
              step_index:           Number(params.step_index ?? 0),
              max_steps:            Number(params.max_steps ?? 10),
              acceptance_met_ratio: params.acceptance_met_ratio != null ? Number(params.acceptance_met_ratio) : undefined,
              last_action:          params.last_action ? String(params.last_action) : undefined,
              last_success:         params.last_success != null ? Boolean(params.last_success) : undefined,
              priority:             params.priority != null ? Number(params.priority) : undefined,
              time_remaining_sec:   params.time_remaining_sec != null ? Number(params.time_remaining_sec) : undefined,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const data = await res.json() as Record<string, unknown>;
          const summary = [
            `⚡ Hamiltonian Decision`,
            `  optimal_action: ${data.optimal_action}`,
            `  confidence:     ${data.confidence}`,
            `  thinking_style: ${data.thinking_style}`,
            `  phase:          ${data.phase}`,
            `  sequence:       ${(data.optimal_sequence as string[] | undefined)?.join(' → ') ?? ''}`,
            `  source:         ${data.source ?? 'engine'}`,
          ].join('\n');
          return { success: true, output: summary, duration_ms: Date.now() - start };
        } catch (e: any) {
          return { success: false, output: '', error: `hamiltonian_decide failed: ${e.message}`, duration_ms: Date.now() - start };
        }
      }

      case 'hamiltonian_rank_actions': {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
        try {
          const res = await fetch(`${baseUrl}/api/hamiltonian`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tool:                  'rank_actions',
              task_goal:             String(params.task_goal || ''),
              current_state_summary: params.current_state_summary ? String(params.current_state_summary) : undefined,
              candidate_actions:     Array.isArray(params.candidate_actions) ? params.candidate_actions : [],
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const data = await res.json() as Record<string, unknown>;
          const ranked = data.ranked_actions as Array<{ rank: number; action: string; energy_delta: number; confidence: number }> | undefined;
          const summary = ranked
            ? ranked.slice(0, 5).map((r) => `  ${r.rank}. ${r.action} (Δ${r.energy_delta}, conf=${r.confidence})`).join('\n')
            : JSON.stringify(data);
          return { success: true, output: `⚡ Ranked Actions:\n${summary}`, duration_ms: Date.now() - start };
        } catch (e: any) {
          return { success: false, output: '', error: `hamiltonian_rank_actions failed: ${e.message}`, duration_ms: Date.now() - start };
        }
      }

      case 'hamiltonian_feedback': {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
        try {
          await fetch(`${baseUrl}/api/hamiltonian`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tool:       'feedback',
              task_id:    String(params.task_id || 'unknown'),
              action:     String(params.action || ''),
              reward:     Number(params.reward ?? 0.5),
              step_index: params.step_index != null ? Number(params.step_index) : undefined,
            }),
            signal: AbortSignal.timeout(6_000),
          });
          return {
            success: true,
            output: `⚡ Hamiltonian feedback logged: action=${params.action} reward=${params.reward}`,
            duration_ms: Date.now() - start,
          };
        } catch (e: any) {
          // Feedback is best-effort — always succeed so it doesn't block the agent
          return {
            success: true,
            output: `Hamiltonian feedback acknowledged (offline): ${e.message}`,
            duration_ms: Date.now() - start,
          };
        }
      }

      default:
        return { success: false, output: '', error: `Unknown tool: ${tool}`, duration_ms: Date.now() - start };
    }
  } catch (e: any) {
    return { success: false, output: '', error: `Tool error: ${e.message}`, duration_ms: Date.now() - start };
  }
}

// ─── LLM Call Helper ────────────────────────────────────────────────

async function callLLM(system: string, user: string, maxTokens = 2048): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);

  try {
    const r = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);

    if (!r.ok) {
      throw new Error(`LLM API ${r.status}: ${await r.text().catch(() => '')}`);
    }

    const j = await r.json() as any;
    return j.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ─── Core Execution Loop ────────────────────────────────────────────

const AGENT_SYSTEM = `You are the SwarmAgents Execution Engine — a relentless autonomous problem-solver.
You receive a task and execute it step-by-step using tools. You NEVER give up.

## Core Loop
1. THINK: Analyze the task, break it into steps, plan your approach
2. ACT: Use a tool to make progress
3. VERIFY: Check the result — did it work? Is the output correct?
4. If failed → DIAGNOSE what went wrong → adjust approach → RETRY
5. Only call task_complete when you have VERIFIED evidence of success
6. Only call task_blocked after exhausting ALL alternatives (minimum 3 different approaches)

## Principles
- Be relentless. If approach A fails, try B, C, D.
- Verify everything. Don't assume success — check outputs, run tests, read files.
- Think before acting. Plan beats brute force.
- Ground yourself in reality. After every action, verify the actual state.
- Small steps. Do one thing at a time, verify, then proceed.

## Available Tools
${TOOL_SCHEMA.map(t => `- ${t.name}: ${t.description}\n  params: ${JSON.stringify(t.params)}`).join('\n\n')}

## Response Format
Respond ONLY with valid JSON:
{
  "thinking": "brief reasoning about current state and next step",
  "action": {
    "tool": "<tool_name>",
    "params": { ... }
  }
}`;

export async function executeTask(
  taskId: string,
  task: string,
  context: string,
  onStep: StepCallback,
  maxRetries = 5,
  maxSteps = 30,
): Promise<ExecutionState> {
  const state: ExecutionState = {
    taskId,
    task,
    context,
    status: 'running',
    steps: [],
    retryCount: 0,
    maxRetries,
    startedAt: Date.now(),
  };

  const conversationHistory: Array<{ role: string; content: string }> = [];

  // Seed the conversation with the task
  const seedPrompt = [
    `TASK: ${task}`,
    context ? `CONTEXT: ${context}` : '',
    '',
    'Begin by thinking about your approach, then execute step by step.',
    'Remember: verify every result before proceeding.',
  ].filter(Boolean).join('\n');

  conversationHistory.push({ role: 'user', content: seedPrompt });

  for (let stepNum = 0; stepNum < maxSteps; stepNum++) {
    try {
      // Get next action from LLM
      const userMessage = conversationHistory.length === 1
        ? seedPrompt
        : conversationHistory[conversationHistory.length - 1].content;

      const rawResponse = await callLLM(AGENT_SYSTEM, userMessage, 2048);

      // Parse the response
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        // LLM didn't return valid JSON — ask it to try again
        conversationHistory.push(
          { role: 'assistant', content: rawResponse },
          { role: 'user', content: 'Invalid response format. You MUST respond with valid JSON containing "thinking" and "action" fields. Try again.' },
        );
        continue;
      }

      let parsed: { thinking?: string; action?: { tool?: string; params?: Record<string, unknown> } };
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        conversationHistory.push(
          { role: 'assistant', content: rawResponse },
          { role: 'user', content: 'JSON parse error. Respond with a single valid JSON object. No markdown, no extra text.' },
        );
        continue;
      }

      const toolName = (parsed.action?.tool || 'think') as ToolName;
      const toolParams = parsed.action?.params || {};
      const thinking = parsed.thinking || '';

      // Determine phase
      let phase: ExecutionStep['phase'] = 'act';
      if (toolName === 'think') phase = 'plan';
      if (thinking.toLowerCase().includes('verify') || thinking.toLowerCase().includes('check')) phase = 'verify';
      if (thinking.toLowerCase().includes('failed') || thinking.toLowerCase().includes('error') || thinking.toLowerCase().includes('wrong')) phase = 'diagnose';
      if (state.retryCount > 0 && (thinking.toLowerCase().includes('retry') || thinking.toLowerCase().includes('alternative'))) phase = 'retry';

      // Execute the tool
      const result = await executeTool(toolName, toolParams);

      const step: ExecutionStep = {
        step: stepNum,
        phase,
        tool: toolName,
        reasoning: thinking,
        result,
        timestamp: Date.now(),
      };

      state.steps.push(step);
      onStep(step, state);

      // Check for terminal conditions
      if (toolName === 'task_complete') {
        state.status = 'completed';
        state.completedAt = Date.now();
        state.finalResult = String(toolParams.result || result.output);
        return state;
      }

      if (toolName === 'task_blocked') {
        if (state.retryCount < maxRetries) {
          // Not truly blocked — force retry with different approach
          state.retryCount++;
          conversationHistory.push(
            { role: 'assistant', content: rawResponse },
            {
              role: 'user',
              content: `You said the task is blocked, but you've only tried ${state.retryCount} of ${maxRetries} approaches. DO NOT give up. Think of a completely different approach and try again. What else could work? Be creative.`,
            },
          );
          continue;
        }
        state.status = 'blocked';
        state.completedAt = Date.now();
        state.error = result.error;
        return state;
      }

      // Feed result back to LLM
      const resultSummary = result.success
        ? `Tool \`${toolName}\` succeeded:\n${result.output.slice(0, 3000)}`
        : `Tool \`${toolName}\` FAILED:\nError: ${result.error}\nOutput: ${result.output.slice(0, 2000)}\n\nDo NOT give up. Diagnose the failure and try a different approach.`;

      conversationHistory.push(
        { role: 'assistant', content: rawResponse },
        { role: 'user', content: resultSummary },
      );

      // Track retries on failures
      if (!result.success) {
        state.retryCount++;
        if (state.retryCount >= maxRetries) {
          // Force one final attempt with a strict nudge
          conversationHistory.push({
            role: 'user',
            content: `WARNING: This is your FINAL attempt (${state.retryCount}/${maxRetries}). If you cannot complete the task now, call task_blocked. Otherwise, make your best attempt with what you have.`,
          });
        }
      }

    } catch (e: any) {
      // LLM call itself failed — retry the step
      const step: ExecutionStep = {
        step: stepNum,
        phase: 'diagnose',
        reasoning: `Execution engine error: ${e.message}`,
        timestamp: Date.now(),
      };
      state.steps.push(step);
      onStep(step, state);

      // Brief pause before retry
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Hit max steps without completing
  state.status = 'failed';
  state.completedAt = Date.now();
  state.error = `Exceeded maximum ${maxSteps} execution steps`;
  return state;
}
