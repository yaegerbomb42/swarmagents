/**
 * SwarmAgents Lab — Agent Blueprint Schema & Type Definitions
 * 
 * Provides declarative data models, validation, serialization, and deserialization
 * for no-code visual agent blueprints and marketplace distribution.
 */

export type ThinkingFramework =
  | 'single-pass'
  | 'react'
  | 'reflective-critic'
  | 'parallel-fanout';

export type PerformanceTier = 'max-reasoning' | 'ultra-fast' | 'local-edge';

export type AgentCategory =
  | 'frontend'
  | 'data-ops'
  | 'rust'
  | 'scraping'
  | 'research'
  | 'auditing'
  | 'fullstack'
  | 'security';

export interface PrebuiltToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  defaultValue?: string | number | boolean;
}

export interface PrebuiltToolDefinition {
  id: 'web-scraper' | 'terminal-compiler' | 'file-parser' | 'sql-executor' | 'ast-analyzer' | 'memory-graph';
  name: string;
  description: string;
  category: string;
  iconName: string;
  parameters: PrebuiltToolParameter[];
  enabled: boolean;
}

export interface CustomToolDefinition {
  id: string;
  name: string;
  description: string;
  parameters: PrebuiltToolParameter[];
  codeOrWebhook?: string;
  enabled: boolean;
}

export interface AgentConstraints {
  strictJsonOnly: boolean;
  noHallucinationStrictMode: boolean;
  stepByStepValidation: boolean;
  boundedMemoryWindow: boolean;
  deterministicSeed: boolean;
}

export interface AgentMethodology {
  framework: ThinkingFramework;
  maxIterations: number;
  criticThreshold: number; // 0 - 100 for reflective-critic
  fanoutWidth: number; // 2 - 8 for parallel-fanout
  constraints: AgentConstraints;
  customInstructions: string;
}

export interface AgentModelRouting {
  performanceTier: PerformanceTier;
  primaryModel: string;
  fallbackModel?: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  useByok: boolean;
  byokProvider?: string;
}

export interface AgentAvatar {
  icon: string; // Lucide icon identifier
  color: string; // Hex or tailwind color class
  bgGlow: string; // Hex glow color
  badgeText?: string;
}

export interface AgentAuthor {
  id: string;
  name: string;
  avatarUrl?: string;
  verified?: boolean;
}

export interface SamplePrompt {
  id: string;
  title: string;
  prompt: string;
  contextSample?: string;
}

export interface AgentBlueprint {
  schemaVersion: '1.0.0';
  id: string;
  name: string;
  role: string;
  description: string;
  domainTags: string[];
  category: AgentCategory;
  avatar: AgentAvatar;
  version: string;
  author: AgentAuthor;
  forkedFromId?: string;
  forkCount: number;
  runCount: number;
  rating: number; // 0.0 - 5.0
  ratingCount: number;
  methodology: AgentMethodology;
  tools: {
    prebuilt: PrebuiltToolDefinition[];
    customTools: CustomToolDefinition[];
  };
  modelRouting: AgentModelRouting;
  samplePrompts: SamplePrompt[];
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export const PREBUILT_TOOLS_CATALOG: PrebuiltToolDefinition[] = [
  {
    id: 'web-scraper',
    name: 'Web Scraper & DOM Extractor',
    description: 'Headless Chromium browser scraper that navigates URLs, renders SPAs, extracts DOM text, and extracts structured tables.',
    category: 'Ingestion',
    iconName: 'Globe',
    parameters: [
      { name: 'url', type: 'string', description: 'Target URL to fetch or scrape', required: true },
      { name: 'selector', type: 'string', description: 'Optional CSS selector to extract', required: false },
      { name: 'extractTables', type: 'boolean', description: 'Parse HTML tables into JSON datasets', required: false, defaultValue: true },
    ],
    enabled: true,
  },
  {
    id: 'terminal-compiler',
    name: 'Terminal & Sandboxed Compiler',
    description: 'Isolated container terminal for building code, running unit test suites, and evaluating bash/GCC/Cargo/npm commands.',
    category: 'Execution',
    iconName: 'Terminal',
    parameters: [
      { name: 'command', type: 'string', description: 'Bash command or compiler command to execute', required: true },
      { name: 'timeoutSec', type: 'number', description: 'Execution timeout in seconds (default 30s)', required: false, defaultValue: 30 },
      { name: 'workingDir', type: 'string', description: 'Working directory path inside sandbox', required: false, defaultValue: '/workspace' },
    ],
    enabled: true,
  },
  {
    id: 'file-parser',
    name: 'File & AST Stream Parser',
    description: 'High-speed multi-format parser for JSON, JSONL, YAML, CSV, Markdown, and tree-sitter AST nodes with streaming.',
    category: 'Analysis',
    iconName: 'FileCode',
    parameters: [
      { name: 'filePath', type: 'string', description: 'Path to local or uploaded file to inspect', required: true },
      { name: 'maxLines', type: 'number', description: 'Maximum lines to stream into context', required: false, defaultValue: 200 },
    ],
    enabled: true,
  },
  {
    id: 'sql-executor',
    name: 'SQL Database Executor',
    description: 'Dialect-aware SQLite and PostgreSQL runner with parameter binding, schema introspection, and result pagination.',
    category: 'Data Ops',
    iconName: 'Database',
    parameters: [
      { name: 'query', type: 'string', description: 'SQL query to execute (read/write guarded)', required: true },
      { name: 'maxRows', type: 'number', description: 'Row limit for returned result set', required: false, defaultValue: 50 },
    ],
    enabled: false,
  },
  {
    id: 'ast-analyzer',
    name: 'AST Invariant Analyzer',
    description: 'Performs static AST code verification, checks type invariants, detects race conditions, and validates syntax trees.',
    category: 'Auditing',
    iconName: 'ShieldAlert',
    parameters: [
      { name: 'codeSnippet', type: 'string', description: 'Source code chunk to analyze for invariant breaks', required: true },
      { name: 'language', type: 'string', description: 'Language dialect (typescript, rust, python, go)', required: true, defaultValue: 'typescript' },
    ],
    enabled: false,
  },
  {
    id: 'memory-graph',
    name: 'Memory Graph & Vector Store',
    description: 'Persistent episodic & semantic memory engine that retrieves historical solution embeddings and entity relations.',
    category: 'Memory',
    iconName: 'Cpu',
    parameters: [
      { name: 'queryKey', type: 'string', description: 'Semantic search query or entity key to retrieve', required: true },
      { name: 'topK', type: 'number', description: 'Number of relevant context memories to return', required: false, defaultValue: 5 },
    ],
    enabled: false,
  },
];

export function createDefaultBlueprint(customName?: string): AgentBlueprint {
  const now = new Date().toISOString();
  const id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  return {
    schemaVersion: '1.0.0',
    id,
    name: customName || 'Systems Architect Agent',
    role: 'Senior Distributed Systems & Concurrency Engineer',
    description: 'Autonomous agent specialized in async rust/typescript architectures, dead-lock detection, and distributed state machines.',
    domainTags: ['Rust', 'TypeScript', 'Concurrency', 'Distributed Systems'],
    category: 'fullstack',
    avatar: {
      icon: 'Cpu',
      color: '#00f5ff',
      bgGlow: 'rgba(0, 245, 255, 0.3)',
      badgeText: 'SYS',
    },
    version: '1.0.0',
    author: {
      id: 'usr-local',
      name: 'Swarm User',
      verified: true,
    },
    forkCount: 0,
    runCount: 0,
    rating: 5.0,
    ratingCount: 1,
    methodology: {
      framework: 'react',
      maxIterations: 8,
      criticThreshold: 85,
      fanoutWidth: 3,
      constraints: {
        strictJsonOnly: false,
        noHallucinationStrictMode: true,
        stepByStepValidation: true,
        boundedMemoryWindow: true,
        deterministicSeed: false,
      },
      customInstructions: 'Always verify concurrency primitives, check error propagation paths, and provide deterministic step-by-step reasoning before generating final code patches.',
    },
    tools: {
      prebuilt: PREBUILT_TOOLS_CATALOG.map((t) => ({
        ...t,
        enabled: t.id === 'terminal-compiler' || t.id === 'file-parser' || t.id === 'ast-analyzer',
      })),
      customTools: [],
    },
    modelRouting: {
      performanceTier: 'max-reasoning',
      primaryModel: 'claude-3-7-sonnet',
      fallbackModel: 'deepseek-v4-flash',
      temperature: 0.2,
      maxTokens: 4096,
      topP: 0.95,
      useByok: false,
    },
    samplePrompts: [
      {
        id: 'sp-1',
        title: 'Audit Mutex Invariant Safety',
        prompt: 'Analyze our async worker queue for lock contention and potential deadlocks under high throughput.',
        contextSample: 'async fn process_job(queue: Arc<Mutex<Vec<Job>>>) -> Result<(), AppError> { ... }',
      },
      {
        id: 'sp-2',
        title: 'Generate Zero-Copy Deserializer',
        prompt: 'Create a high-performance zero-copy binary parser for network packet frames.',
      },
    ],
    isPublic: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateBlueprint(obj: unknown): { valid: boolean; errors: string[]; blueprint?: AgentBlueprint } {
  const errors: string[] = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['Manifest must be a non-null JSON object'] };
  }

  const b = obj as Partial<AgentBlueprint>;

  if (!b.name || typeof b.name !== 'string' || b.name.trim().length === 0) {
    errors.push('Agent Name is required.');
  }
  if (!b.role || typeof b.role !== 'string') {
    errors.push('Agent Role/Specialty is required.');
  }
  if (!b.methodology || typeof b.methodology !== 'object') {
    errors.push('Methodology configuration is missing.');
  } else {
    if (!['single-pass', 'react', 'reflective-critic', 'parallel-fanout'].includes(b.methodology.framework)) {
      errors.push('Invalid thinking framework methodology.');
    }
  }
  if (!b.modelRouting || typeof b.modelRouting !== 'object') {
    errors.push('Model Routing configuration is missing.');
  }
  if (!b.tools || typeof b.tools !== 'object' || !Array.isArray(b.tools.prebuilt)) {
    errors.push('Tools definition is malformed.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Ensure default fallback values for any missing optional properties
  const sanitized: AgentBlueprint = {
    schemaVersion: '1.0.0',
    id: b.id || `agent-${Date.now().toString(36)}`,
    name: b.name || 'Custom Agent',
    role: b.role || 'General Assistant',
    description: b.description || '',
    domainTags: Array.isArray(b.domainTags) ? b.domainTags : ['General'],
    category: (b.category as AgentCategory) || 'fullstack',
    avatar: {
      icon: b.avatar?.icon || 'Bot',
      color: b.avatar?.color || '#00f5ff',
      bgGlow: b.avatar?.bgGlow || 'rgba(0, 245, 255, 0.3)',
      badgeText: b.avatar?.badgeText || 'AGT',
    },
    version: b.version || '1.0.0',
    author: {
      id: b.author?.id || 'usr-local',
      name: b.author?.name || 'Local Builder',
      verified: !!b.author?.verified,
    },
    forkCount: Number(b.forkCount) || 0,
    runCount: Number(b.runCount) || 0,
    rating: Number(b.rating) || 5.0,
    ratingCount: Number(b.ratingCount) || 1,
    methodology: {
      framework: b.methodology?.framework || 'react',
      maxIterations: Number(b.methodology?.maxIterations) || 6,
      criticThreshold: Number(b.methodology?.criticThreshold) || 80,
      fanoutWidth: Number(b.methodology?.fanoutWidth) || 3,
      constraints: {
        strictJsonOnly: !!b.methodology?.constraints?.strictJsonOnly,
        noHallucinationStrictMode: !!b.methodology?.constraints?.noHallucinationStrictMode,
        stepByStepValidation: !!b.methodology?.constraints?.stepByStepValidation,
        boundedMemoryWindow: !!b.methodology?.constraints?.boundedMemoryWindow,
        deterministicSeed: !!b.methodology?.constraints?.deterministicSeed,
      },
      customInstructions: b.methodology?.customInstructions || '',
    },
    tools: {
      prebuilt: Array.isArray(b.tools?.prebuilt) ? b.tools.prebuilt : PREBUILT_TOOLS_CATALOG,
      customTools: Array.isArray(b.tools?.customTools) ? b.tools.customTools : [],
    },
    modelRouting: {
      performanceTier: b.modelRouting?.performanceTier || 'max-reasoning',
      primaryModel: b.modelRouting?.primaryModel || 'deepseek-v4-flash',
      fallbackModel: b.modelRouting?.fallbackModel || 'groq-llama-3.3-70b',
      temperature: typeof b.modelRouting?.temperature === 'number' ? b.modelRouting.temperature : 0.3,
      maxTokens: Number(b.modelRouting?.maxTokens) || 4096,
      topP: Number(b.modelRouting?.topP) || 0.95,
      useByok: !!b.modelRouting?.useByok,
      byokProvider: b.modelRouting?.byokProvider,
    },
    samplePrompts: Array.isArray(b.samplePrompts) ? b.samplePrompts : [],
    isPublic: !!b.isPublic,
    createdAt: b.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return { valid: true, errors: [], blueprint: sanitized };
}

export function exportBlueprintToJson(blueprint: AgentBlueprint): string {
  return JSON.stringify(blueprint, null, 2);
}

export function exportBlueprintToYaml(blueprint: AgentBlueprint): string {
  const lines: string[] = [];
  lines.push(`schemaVersion: "${blueprint.schemaVersion}"`);
  lines.push(`id: "${blueprint.id}"`);
  lines.push(`name: "${blueprint.name.replace(/"/g, '\\"')}"`);
  lines.push(`role: "${blueprint.role.replace(/"/g, '\\"')}"`);
  lines.push(`description: "${blueprint.description.replace(/"/g, '\\"')}"`);
  lines.push(`category: "${blueprint.category}"`);
  lines.push(`version: "${blueprint.version}"`);
  lines.push(`domainTags:`);
  blueprint.domainTags.forEach((t) => lines.push(`  - "${t}"`));
  
  lines.push(`avatar:`);
  lines.push(`  icon: "${blueprint.avatar.icon}"`);
  lines.push(`  color: "${blueprint.avatar.color}"`);
  lines.push(`  badgeText: "${blueprint.avatar.badgeText || ''}"`);

  lines.push(`methodology:`);
  lines.push(`  framework: "${blueprint.methodology.framework}"`);
  lines.push(`  maxIterations: ${blueprint.methodology.maxIterations}`);
  lines.push(`  criticThreshold: ${blueprint.methodology.criticThreshold}`);
  lines.push(`  fanoutWidth: ${blueprint.methodology.fanoutWidth}`);
  lines.push(`  constraints:`);
  lines.push(`    strictJsonOnly: ${blueprint.methodology.constraints.strictJsonOnly}`);
  lines.push(`    noHallucinationStrictMode: ${blueprint.methodology.constraints.noHallucinationStrictMode}`);
  lines.push(`    stepByStepValidation: ${blueprint.methodology.constraints.stepByStepValidation}`);
  lines.push(`    boundedMemoryWindow: ${blueprint.methodology.constraints.boundedMemoryWindow}`);
  lines.push(`    deterministicSeed: ${blueprint.methodology.constraints.deterministicSeed}`);
  lines.push(`  customInstructions: |`);
  blueprint.methodology.customInstructions.split('\n').forEach((l) => lines.push(`    ${l}`));

  lines.push(`modelRouting:`);
  lines.push(`  performanceTier: "${blueprint.modelRouting.performanceTier}"`);
  lines.push(`  primaryModel: "${blueprint.modelRouting.primaryModel}"`);
  lines.push(`  temperature: ${blueprint.modelRouting.temperature}`);
  lines.push(`  maxTokens: ${blueprint.modelRouting.maxTokens}`);

  lines.push(`tools:`);
  lines.push(`  activePrebuilt:`);
  blueprint.tools.prebuilt.filter((p) => p.enabled).forEach((p) => lines.push(`    - "${p.id}"`));
  
  if (blueprint.tools.customTools.length > 0) {
    lines.push(`  customTools:`);
    blueprint.tools.customTools.forEach((c) => {
      lines.push(`    - id: "${c.id}"`);
      lines.push(`      name: "${c.name}"`);
      lines.push(`      description: "${c.description}"`);
    });
  }

  return lines.join('\n');
}
