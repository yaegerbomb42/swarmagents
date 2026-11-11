/**
 * Realistic mock scenarios for Omnexx VS Code Extension UI development & visual testing.
 * Used by preview/index.html (workbench) and scripts/capture-ui.mjs (headless screenshots).
 *
 * Mock messages must use the real chat-server protocol shapes (see
 * vscode/src/webview/chat.ts): todos carry `status: 'pending' |
 * 'in_progress' | 'done'` — the webview never reads `done`/`active`, so a
 * todo written that way renders as queued and the HUD step count is wrong.
 */

const ALL_SCENARIOS = {
  '01_welcome': {
    name: '01. Welcome & Empty State',
    description:
      'Fresh session with quick start cards, dormant/wake power switch, and clean composer.',
    actions: ['closeOverlays'],
    messages: [
      { type: 'ready' },
      {
        type: 'prefs',
        autoApproveDefault: false,
        lazyToolDiscovery: false,
      },
      {
        type: 'models',
        items: [
          { ref: 'gemini-2.5-flash', provider: 'google', model: 'gemini-2.5-flash' },
          { ref: 'claude-3-7-sonnet', provider: 'anthropic', model: 'claude-3-7-sonnet' },
          { ref: 'ollama:qwen2.5-coder:7b', provider: 'ollama', model: 'qwen2.5-coder:7b' },
        ],
        current: 'gemini-2.5-flash',
        unreachable: [],
      },
      {
        type: 'state',
        entries: [],
        live: '',
        todos: [],
        pending: null,
        mode: 'chat',
        busy: false,
        paused: false,
        autoApprove: false,
        trace: false,
        model: 'gemini-2.5-flash',
        routing: null,
        context: {
          used: 4210,
          limit: 128000,
          parts: { system: 2100, tools: 1450, conversation: 660 },
        },
        memoryNote: null,
        usage: {
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          usd: 0,
          turns: 0,
          toolCalls: 0,
          toolErrors: 0,
          compactions: 0,
          startedAt: null,
        },
      },
      { type: 'daemonState', running: false },
    ],
  },

  '02_streaming_think': {
    name: '02. Active Streaming & Chain-of-Thought',
    description: 'Agent actively thinking and generating response with live mission timeline.',
    actions: ['closeOverlays'],
    messages: [
      { type: 'ready' },
      {
        type: 'state',
        entries: [
          {
            id: 1,
            kind: 'user',
            text: 'Configure Vite code splitting in vite.config.js so every chunk is under 500 kB without breaking tests.',
          },
          {
            id: 2,
            kind: 'think',
            text: 'Inspecting `vite.config.js` and `package.json`...\nThree.js currently bundles as a single 520 kB vendor module in `build/three.module.js`.\nTo split it under 500 kB, I need to resolve aliases directly to `three/src/Three.js` and partition renderers, math, and postprocessing into dedicated manualChunks.',
          },
        ],
        live: 'I am analyzing the bundle structure. I will now inspect the Three.js import graph and split the vendor chunks into smaller modules under 500 kB:\n\n- `vendor-three-renderers` (~375 kB)\n- `vendor-three-math` (~70 kB)\n- `vendor-physics` (cannon-es ~82 kB)',
        todos: [
          { id: '1', text: 'Analyze current bundle chunk sizes', status: 'done' },
          { id: '2', text: 'Configure resolve aliases for Three.js source', status: 'done' },
          {
            id: '3',
            text: 'Define manualChunks for submodules in vite.config.js',
            status: 'in_progress',
          },
          {
            id: '4',
            text: 'Verify build with npm run build and run smoke tests',
            status: 'pending',
          },
        ],
        pending: null,
        mode: 'chat',
        busy: true,
        paused: false,
        autoApprove: false,
        trace: false,
        model: 'gemini-2.5-flash',
        context: {
          used: 38450,
          limit: 128000,
          parts: { system: 4200, tools: 6100, conversation: 28150 },
        },
        usage: {
          tokens: { input: 34100, cacheRead: 18200, cacheWrite: 4100, output: 1450 },
          usd: 0.0042,
          turns: 3,
          toolCalls: 4,
          toolErrors: 0,
          compactions: 0,
          startedAt: Date.now() - 42000,
        },
      },
    ],
  },

  '03_tools_diffs': {
    name: '03. Tool Execution & Diffs',
    description:
      'Live run in progress: a running tool cluster (live tool item, active card) alongside the running terminal pill, plus file edits and structured results.',
    actions: ['closeOverlays'],
    messages: [
      { type: 'ready' },
      { type: 'pillStart', id: 4, cmd: 'npm run build' },
      {
        type: 'pillOutput',
        id: 4,
        chunk:
          'vite v6.4.5 building for production...\n✓ 455 modules transformed.\nrendering chunks...\ndist/assets/vendor-three-renderers.js  375.83 kB\ndist/assets/vendor-physics.js          82.85 kB\ndist/assets/vendor-three-math.js       70.12 kB\n✓ built in 648ms\n',
      },
      // No pillEnd: pill 4 stays running so the glowing running state shows in the shot.
      {
        type: 'state',
        entries: [
          {
            id: 1,
            kind: 'user',
            text: 'Split the bundle and verify tests pass.',
          },
          {
            id: 2,
            kind: 'act',
            text: 'reading vite.config.js',
          },
          {
            id: 3,
            kind: 'act',
            text: 'writing code to vite.config.js (+66, -2)',
          },
          {
            id: 4,
            kind: 'act',
            text: 'running npm run build',
          },
          {
            id: 5,
            kind: 'act',
            text: 'running npm test (4 passed)',
          },
          {
            id: 6,
            kind: 'out',
            text: '### Bundle Optimization Complete ✅\n\nAll chunks are now well under the **500 kB** threshold:\n\n| Chunk | Size | Gzip |\n| :--- | :--- | :--- |\n| `vendor-three-renderers` | **375.83 kB** | 108.4 kB |\n| `vendor-physics` (cannon-es) | **82.85 kB** | 24.1 kB |\n| `vendor-three-math` | **70.12 kB** | 20.2 kB |\n\nAll **4 smoke test suites** and `tsc --noEmit` passed with 0 errors.\n\n```diff\n--- a/vite.config.js\n+++ b/vite.config.js\n@@ -3,6 +3,7 @@\n+import { resolve } from "node:path";\n   build: {\n+    target: "es2022",\n     rollupOptions: {\n       output: {\n         manualChunks: {\n           "vendor-three-renderers": [\n-            "three",\n```',
          },
          // Trailing act entry: the last block is a tool cluster, so with
          // busy set it renders as .msg.tool-card.is-active with its last
          // item .tool.is-live — the live states, exercised, not just CSS.
          {
            id: 7,
            kind: 'act',
            text: 'reading dist/assets/vendor-three-renderers.js',
          },
        ],
        live: '',
        todos: [
          { id: '1', text: 'Configure Vite manualChunks and aliases', status: 'done' },
          { id: '2', text: 'Verify build under 500 kB', status: 'done' },
          { id: '3', text: 'Run smoke test suite', status: 'in_progress' },
        ],
        pending: null,
        mode: 'chat',
        busy: true,
        paused: false,
        autoApprove: false,
        trace: false,
        model: 'gemini-2.5-flash',
        context: {
          used: 28900,
          limit: 128000,
          parts: { system: 4200, tools: 6100, conversation: 18600 },
        },
        usage: {
          tokens: { input: 52100, cacheRead: 31000, cacheWrite: 5200, output: 2840 },
          usd: 0.0078,
          turns: 5,
          toolCalls: 6,
          toolErrors: 0,
          compactions: 0,
          startedAt: Date.now() - 95000,
        },
      },
    ],
  },

  '04_approval_gate': {
    name: '04. Approval Gate (Command Review)',
    description:
      'Security confirmation modal requiring explicit user consent for potentially sensitive operations.',
    actions: ['closeOverlays'],
    messages: [
      { type: 'ready' },
      {
        type: 'state',
        entries: [
          {
            id: 1,
            kind: 'user',
            text: 'Clean up the build artifacts and reset the git worktree.',
          },
        ],
        live: '',
        todos: [{ id: '1', text: 'Clean untracked files and build caches', status: 'in_progress' }],
        pending:
          'Execute bash command:\n`git clean -fdx && rm -rf dist`\n\nThis will remove all untracked files and local build caches.',
        pendingLabels: { yes: 'Allow (⌘+Enter)', no: 'Deny (Esc)' },
        mode: 'chat',
        busy: true,
        paused: false,
        autoApprove: false,
        trace: false,
        model: 'gemini-2.5-flash',
        context: {
          used: 14200,
          limit: 128000,
          parts: { system: 4200, tools: 4100, conversation: 5900 },
        },
        usage: {
          tokens: { input: 12000, cacheRead: 8000, cacheWrite: 1000, output: 400 },
          usd: 0.0018,
          turns: 1,
          toolCalls: 1,
          toolErrors: 0,
          compactions: 0,
          startedAt: Date.now() - 15000,
        },
      },
    ],
  },

  '05_context_cockpit': {
    name: '05. Context Inspector & Token Cockpit',
    description:
      'Context allocation breakdown showing system prompt, tools, memory note, and mounted files.',
    actions: ['openInspector'],
    messages: [
      { type: 'ready' },
      {
        type: 'contextFiles',
        files: [
          { path: 'vite.config.js', editable: true, tokens: 1240 },
          { path: 'package.json', editable: true, tokens: 820 },
          { path: 'src/main.js', editable: true, tokens: 3410 },
          { path: 'src/ai/ZombieManager.ts', editable: true, tokens: 4650 },
          { path: 'src/ai/NavGrid.ts', editable: true, tokens: 2890 },
        ],
      },
      {
        type: 'contextItems',
        budget: 128000,
        busy: false,
        items: [
          {
            id: 'sys_1',
            group: 'system',
            label: 'System Prompt & Anti-Loop Rules',
            text: 'You are Omnexx, an autonomous software engineering assistant...',
            tokens: 4200,
            edited: false,
            removed: false,
            editable: false,
          },
          {
            id: 'tools_1',
            group: 'tools',
            label: 'CLI & File Tool Schemas (12 tools)',
            text: 'Tools: read_file, write_file, edit_file, run_command, git_status...',
            tokens: 6100,
            edited: false,
            removed: false,
            editable: false,
          },
          {
            id: 'notes_1',
            group: 'notes',
            label: 'Institutional Memory (WHY.md excerpt)',
            text: '- Three.js must be aliased to source to split under 500 kB.\n- Keep all smoke tests passing.',
            tokens: 1850,
            edited: false,
            removed: false,
            editable: true,
          },
          {
            id: 'chat_1',
            group: 'chat',
            label: 'Conversation & Step History (Turn 1-5)',
            text: 'User: Split the bundle...\nAssistant: Configured manualChunks in vite.config.js...',
            tokens: 28400,
            edited: false,
            removed: false,
            editable: false,
          },
        ],
      },
      {
        type: 'state',
        entries: [
          { id: 1, kind: 'user', text: 'Show context breakdown' },
          { id: 2, kind: 'out', text: 'Here is the current active context state.' },
        ],
        live: '',
        todos: [],
        pending: null,
        mode: 'chat',
        busy: false,
        paused: false,
        autoApprove: false,
        model: 'gemini-2.5-flash',
        context: {
          used: 48920,
          limit: 128000,
          parts: { system: 8200, tools: 14500, conversation: 26220 },
        },
        memoryNote:
          '- Project Deadzone: 3D survival game with Three.js and Cannon-es.\n- Subsystems converted to TypeScript: Core, AI, World, Save.\n- Bundle chunk limit strictly enforced at 500 kB.',
        usage: {
          tokens: { input: 89000, cacheRead: 54000, cacheWrite: 12000, output: 6200 },
          usd: 0.0152,
          turns: 8,
          toolCalls: 12,
          toolErrors: 0,
          compactions: 1,
          startedAt: Date.now() - 320000,
        },
      },
    ],
  },

  '06_settings': {
    name: '06. Settings & Model Matrix',
    description:
      'Settings panel displaying model configurations, providers, and autonomous parameters.',
    actions: ['openSettings'],
    messages: [
      { type: 'ready' },
      {
        type: 'models',
        items: [
          { ref: 'gemini-2.5-flash', provider: 'google', model: 'gemini-2.5-flash' },
          { ref: 'claude-3-7-sonnet', provider: 'anthropic', model: 'claude-3-7-sonnet' },
          { ref: 'gpt-4o', provider: 'openai', model: 'gpt-4o' },
          { ref: 'ollama:qwen2.5-coder:7b', provider: 'ollama', model: 'qwen2.5-coder:7b' },
          { ref: 'ollama:deepseek-r1:14b', provider: 'ollama', model: 'deepseek-r1:14b' },
        ],
        current: 'gemini-2.5-flash',
        unreachable: [],
      },
      // A small provider catalog so the tile search can be exercised against
      // a real tile name (typing "ollama" should leave exactly one tile).
      {
        type: 'settings',
        catalog: [
          { name: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', local: true },
          {
            name: 'openai',
            label: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            local: false,
            signup: 'https://platform.openai.com/signup',
          },
          {
            name: 'anthropic',
            label: 'Anthropic',
            baseUrl: 'https://api.anthropic.com/v1',
            local: false,
            signup: 'https://console.anthropic.com/',
          },
        ],
        connected: [],
      },
      // Real agentSettings payload (same shape the chat server sends): without
      // it the Agent tab renders "Loading agent settings…" forever and its
      // five sliders can never be exercised in the preview.
      {
        type: 'agentSettings',
        levels: { taskEffort: 5, turnEffort: 5, contextLevel: 6, time: '2h', maxTokens: 16000 },
        askOnStart: false,
        saved: true,
        meta: {
          task: [
            'quick MVP, easiest way that works',
            'minimal change, no extras',
            'small focused change, light planning',
            'solid change with basic tests',
            'balanced: plan briefly, test what you touch',
            'thorough: plan, test, handle edge cases',
            'broad: milestones, full tests, polish',
            'ambitious: deep analysis, wide scope',
            'very ambitious: hours of work, extend the scope',
            'monolith: build as much as it can',
          ],
          turn: [
            'no extra thinking',
            'a glance',
            'light thought',
            'some thought',
            'balanced',
            'careful',
            'deliberate',
            'deep',
            'very deep',
            'maximum thinking',
          ],
          context: [
            { tokens: 5000, label: 'bare: goal, last turn, tools' },
            { tokens: 10000, label: 'goal and the last few turns' },
            { tokens: 20000, label: 'small: recent turns, short notes' },
            { tokens: 40000, label: 'compact working set' },
            { tokens: 64000, label: 'standard' },
            { tokens: 96000, label: 'roomy' },
            { tokens: 128000, label: 'large' },
            { tokens: 200000, label: 'very large' },
            { tokens: 500000, label: 'huge: long sessions on big repos' },
            { tokens: 1000000, label: 'maximum: 1M-window models (Gemini, Claude, GPT-4.1)' },
          ],
          time: ['5m', '15m', '30m', '1h', '2h', '4h', '8h', 'unlimited'],
          tokens: [1024, 2048, 4096, 8192, 16000, 32000, 64000],
        },
      },
      {
        type: 'state',
        entries: [],
        live: '',
        todos: [],
        pending: null,
        mode: 'chat',
        busy: false,
        paused: false,
        autoApprove: false,
        model: 'gemini-2.5-flash',
        context: { used: 4210, limit: 128000 },
        usage: null,
      },
    ],
  },

  '07_sandbox_scrubber': {
    name: '07. Sandbox Scrubber Timeline',
    description:
      'Sandbox state and git checkpoint scrubber allowing instant deterministic state rollback.',
    actions: ['closeOverlays', 'showScrubber'],
    messages: [
      { type: 'ready' },
      {
        type: 'sandboxState',
        checkpoints: [
          {
            id: 'cp_0',
            index: 0,
            label: 't_0: initial baseline',
            createdAt: Date.now() - 180000,
            gitRef: '39d2890',
          },
          {
            id: 'cp_1',
            index: 1,
            label: 't_1: AI subsystem converted',
            createdAt: Date.now() - 120000,
            gitRef: 'e30a236',
          },
          {
            id: 'cp_2',
            index: 2,
            label: 't_2: vite manualChunks split',
            createdAt: Date.now() - 60000,
            gitRef: 'da9b280',
          },
          {
            id: 'cp_3',
            index: 3,
            label: 't_3: bundle verified under 500kB',
            createdAt: Date.now() - 10000,
            gitRef: 'HEAD',
          },
        ],
        currentCheckpointId: 'cp_3',
      },
      {
        type: 'state',
        entries: [
          { id: 1, kind: 'user', text: 'Show checkpoint history' },
          { id: 2, kind: 'out', text: 'Sandbox timeline initialized with 4 verified checkpoints.' },
        ],
        live: '',
        todos: [],
        pending: null,
        mode: 'chat',
        busy: false,
        paused: false,
        autoApprove: false,
        model: 'gemini-2.5-flash',
        context: { used: 12400, limit: 128000 },
        usage: null,
      },
    ],
  },
};

if (typeof window !== 'undefined') {
  window.SCENARIOS = ALL_SCENARIOS;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ALL_SCENARIOS;
}
