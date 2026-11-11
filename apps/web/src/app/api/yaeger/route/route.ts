/// <reference types="node" />

// SwarmAgent Model Routing & Coordination API
// Dynamically routes tasks to the appropriate SwarmAgent model based on complexity analysis.
//
// Request body:
//   {
//     task: string,
//     context?: string,
//     preferred_model?: "swarmagent-core-16.9b" | "swarmagent-router-16.9b" | "swarmagent-general-1.1b",
//     force_model?: boolean,         // bypass routing, use preferred_model directly
//     system_instruction?: string,
//     messages?: ChatMessage[],
//   }
//
// Response:
//   {
//     ok: true,
//     routing: {
//       selected_model: string,
//       confidence: number,
//       complexity_score: number,
//       routing_reason: string,
//       estimated_tokens: number,
//     },
//     result: { content: string, tokens_used?: number },
//   }

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

interface SwarmAgentRouteBody {
  task: string;
  context?: string;
  preferred_model?: 'swarmagent-core-16.9b' | 'swarmagent-router-16.9b' | 'swarmagent-general-1.1b';
  force_model?: boolean;
  system_instruction?: string;
  messages?: ChatMessage[];
}

// ─── Task Complexity Classifier ──────────────────────────────

const COMPLEXITY_PATTERNS = {
  high: [
    /\barchitect|design\s+pattern|system\s+design|framework|abstract\b/i,
    /\bproof|theorem|lemma|verify|formal\s+verification|mathematical\b/i,
    /\bplan|strategy|roadmap|decompose|break\s+down\b/i,
    /\banalyze|evaluate|compare|trade.off|optimize\b/i,
    /\bcoordination|orchestration|multi.agent|swarm\b/i,
    /\bdebug|troubleshoot|root\s+cause|investigate\b/i,
    /\breason|infer|deduce|synthesize|critique\b/i,
  ],
  medium: [
    /\bimplement|build|create|develop|write\b/i,
    /\brefactor|restructure|migrate|upgrade\b/i,
    /\btest|validate|assert|benchmark\b/i,
    /\bquery|database|API|endpoint|service\b/i,
  ],
  low: [
    /\brun|execute|call|invoke|trigger\b/i,
    /\bprint|log|output|display|format\b/i,
    /\bedit|fix|patch|update|change\b/i,
    /\bsummarize|list|enumerate|extract\b/i,
    /\bfile|path|directory|copy|move\b/i,
  ],
};

function classifyTask(task: string): {
  complexity: 'high' | 'medium' | 'low';
  score: number;
  reason: string;
} {
  const text = task.toLowerCase();
  let highScore = 0;
  let mediumScore = 0;
  let lowScore = 0;

  for (const pattern of COMPLEXITY_PATTERNS.high) {
    if (pattern.test(text)) highScore += 2;
  }
  for (const pattern of COMPLEXITY_PATTERNS.medium) {
    if (pattern.test(text)) mediumScore += 1.5;
  }
  for (const pattern of COMPLEXITY_PATTERNS.low) {
    if (pattern.test(text)) lowScore += 1;
  }

  // Token length heuristic
  const tokenEstimate = Math.ceil(text.length / 4);
  if (tokenEstimate > 500) highScore += 1;
  else if (tokenEstimate > 200) mediumScore += 0.5;

  const total = highScore + mediumScore + lowScore;
  if (total === 0) {
    // Default: short tasks = low, long = medium
    return tokenEstimate > 300
      ? { complexity: 'medium', score: 0.5, reason: 'Default routing: moderate length task' }
      : { complexity: 'low', score: 0.3, reason: 'Default routing: short execution task' };
  }

  const highRatio = highScore / total;
  const mediumRatio = mediumScore / total;

  if (highRatio > 0.4) {
    return {
      complexity: 'high',
      score: Math.min(0.95, 0.5 + highRatio * 0.4),
      reason: `High complexity: ${Math.round(highRatio * 100)}% reasoning/planning indicators`,
    };
  }
  if (mediumRatio > 0.4 || highScore > 0) {
    return {
      complexity: 'medium',
      score: Math.min(0.75, 0.4 + mediumRatio * 0.3),
      reason: `Medium complexity: ${Math.round(mediumRatio * 100)}% implementation indicators`,
    };
  }
  return {
    complexity: 'low',
    score: Math.min(0.5, 0.2 + lowScore * 0.05),
    reason: `Low complexity: ${Math.round(lowScore)} execution indicators`,
  };
}

// ─── Model Router ──────────────────────────────────────────

interface ModelProfile {
  id: string;
  parameters: string;
  role: 'coordinator' | 'router' | 'executor' | 'classifier';
  strengths: string[];
  endpoint: string;
  contextWindow: number;
}

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';

const MODELS: Record<string, ModelProfile> = {
  'swarmagent-core-16.9b': {
    id: 'swarmagent-core-16.9b',
    parameters: '16.9B',
    role: 'coordinator',
    strengths: ['high reasoning', 'long context', 'planning', 'architecture design', 'debugging'],
    endpoint: `${OLLAMA_BASE}/api/generate`,
    contextWindow: 32768,
  },
  'swarmagent-router-16.9b': {
    id: 'swarmagent-router-16.9b',
    parameters: '16.9B',
    role: 'router',
    strengths: ['medium reasoning', 'faster inference', 'routing', 'code review'],
    endpoint: `${OLLAMA_BASE}/api/generate`,
    contextWindow: 32768,
  },
  'swarmagent-general-1.1b': {
    id: 'swarmagent-general-1.1b',
    parameters: '1.1B',
    role: 'executor',
    strengths: ['fast execution', 'tool calling', 'syntax generation', 'terminal commands', 'file edits'],
    endpoint: `${OLLAMA_BASE}/api/generate`,
    contextWindow: 8192,
  },
};

// RESTRICTED: legacy yaeger 14m and 256m per spec
const RESTRICTED_MODELS = ['yaeger14m', 'yaeger-14m', 'yaeger:14m'];
const CLASSIFICATION_ONLY = ['yaeger256m', 'yaeger-256m', 'yaeger:256m'];

function selectModel(
  classification: ReturnType<typeof classifyTask>,
  preferred?: string,
  force = false
): { model: string; reason: string; confidence: number } {
  if (force && preferred && MODELS[preferred]) {
    return { model: preferred, reason: 'User forced model selection', confidence: 1.0 };
  }

  // Enforce restrictions
  if (preferred && RESTRICTED_MODELS.includes(preferred)) {
    return { model: 'swarmagent-core-16.9b', reason: 'RESTRICTED: yaeger 14m lacks parameter density for JSON-RPC coherence. Routed to swarmagent-core-16.9b.', confidence: 1.0 };
  }
  if (preferred && CLASSIFICATION_ONLY.includes(preferred)) {
    return { model: 'swarmagent-general-1.1b', reason: 'RESTRICTED: yaeger 256m is classification-only. Routed to swarmagent-general-1.1b for execution.', confidence: 1.0 };
  }

  switch (classification.complexity) {
    case 'high':
      return {
        model: 'swarmagent-core-16.9b',
        reason: `${classification.reason} → Routed to Core (swarmagent-core-16.9b) for high reasoning capacity`,
        confidence: classification.score,
      };
    case 'medium':
      return {
        model: preferred === 'swarmagent-router-16.9b' ? 'swarmagent-router-16.9b' : 'swarmagent-core-16.9b',
        reason: `${classification.reason} → Routed to ${preferred === 'swarmagent-router-16.9b' ? 'Router (swarmagent-router-16.9b)' : 'Core (swarmagent-core-16.9b)'}`,
        confidence: classification.score,
      };
    case 'low':
      return {
        model: 'swarmagent-general-1.1b',
        reason: `${classification.reason} → Routed to General (swarmagent-general-1.1b) for fast execution`,
        confidence: classification.score,
      };
  }
}

// ─── Ollama Inference ──────────────────────────────────────

async function callOllama(
  model: string,
  prompt: string,
  system?: string
): Promise<{ content: string; tokens?: number }> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system: system || '',
      stream: false,
      options: { temperature: 0.6, num_predict: 1200 },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    content: data.response ?? '',
    tokens: data.eval_count,
  };
}

// ─── API Handlers ──────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SwarmAgentRouteBody;

    if (!body.task || typeof body.task !== 'string') {
      return NextResponse.json({ ok: false, error: 'missing_task' }, { status: 400 });
    }

    // Classify
    const classification = classifyTask(body.task);

    // Route
    const routing = selectModel(classification, body.preferred_model, body.force_model);

    // Build prompt
    const prompt = body.context
      ? `[Context]\n${body.context}\n\n[Task]\n${body.task}`
      : body.task;

    // Execute
    let result: { content: string; tokens?: number };
    try {
      result = await callOllama(routing.model, prompt, body.system_instruction);
    } catch (e: any) {
      // Fallback: if general fails for high complexity, retry with core
      if (routing.model === 'swarmagent-general-1.1b' && classification.complexity !== 'low') {
        result = await callOllama('swarmagent-core-16.9b', prompt, body.system_instruction);
        routing.model = 'swarmagent-core-16.9b';
        routing.reason += ' (fallback: general failed, upgraded to core)';
      } else {
        throw e;
      }
    }

    return NextResponse.json({
      ok: true,
      routing: {
        selected_model: routing.model,
        confidence: routing.confidence,
        complexity_score: classification.score,
        routing_reason: routing.reason,
        estimated_tokens: Math.ceil(prompt.length / 4),
      },
      result: {
        content: result.content,
        tokens_used: result.tokens,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// GET returns model catalog and routing rules
export async function GET() {
  return NextResponse.json({
    ok: true,
    models: MODELS,
    restricted: {
      never_use: RESTRICTED_MODELS,
      classification_only: CLASSIFICATION_ONLY,
    },
    routing_rules: {
      high_complexity: 'swarmagent-core-16.9b (coordinator)',
      medium_complexity: 'swarmagent-router-16.9b or swarmagent-core-16.9b',
      low_complexity: 'swarmagent-general-1.1b (executor)',
    },
    acquisition: {
      'swarmagent-core-16.9b': 'ollama pull swarmagent-core-16.9b  # ~15.7GB, requires 32GB+ RAM',
      'swarmagent-router-16.9b': 'ollama pull swarmagent-router-16.9b  # ~8.9GB, requires 16GB+ RAM',
      'swarmagent-general-1.1b': 'ollama pull swarmagent-general-1.1b  # ~2GB, fast execution',
    },
  });
}
