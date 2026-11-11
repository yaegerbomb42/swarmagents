// Multi-Model GGUF Inference Engine
// Discovers available models and routes tasks to the best one

import { spawn } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";

export interface GGUFModel {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  sizeGB: number;
  quant: string;
  parameters: string;
  strengths: string[];
  contextWindow: number;
  ramRequiredGB: number;
  available: boolean;
}

// Model definitions with metadata
// Matches actual GGUF files in ~/Desktop/swarmagents-models/models
const MODEL_REGISTRY: Omit<GGUFModel, "path" | "sizeBytes" | "sizeGB" | "available">[] = [
  {
    id: "deepseek-r1-70b",
    name: "70B Ternary Brain (DeepSeek-R1-Llama)",
    quant: "IQ1_S",
    parameters: "70B",
    strengths: ["orchestration", "complex reasoning", "planning", "architecture", "long-horizon tasks"],
    contextWindow: 16384,
    ramRequiredGB: 24,
  },
  {
    id: "qwen3.6-35b-moe",
    name: "35B MoE Specialist (Qwen3.6-A3B)",
    quant: "Q4_K_M",
    parameters: "35B (3B active)",
    strengths: ["reasoning", "multilingual", "coding", "math", "fast MoE inference"],
    contextWindow: 16384,
    ramRequiredGB: 24,
  },
  {
    id: "deepseek-r1-8b",
    name: "8B Swarm Grunt (DeepSeek-R1-Qwen3)",
    quant: "Q4_K_M",
    parameters: "8B",
    strengths: ["task execution", "tool use", "coding", "reasoning", "worker agent"],
    contextWindow: 8192,
    ramRequiredGB: 8,
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B Specialist",
    quant: "Q4_K_M",
    parameters: "12B",
    strengths: ["multimodal", "instruction following", "coding", "self-correction"],
    contextWindow: 16384,
    ramRequiredGB: 12,
  },
];

// File patterns for each model (actual filenames in swarmagents-models/)
const MODEL_FILE_PATTERNS: Record<string, string[]> = {
  "deepseek-r1-70b": ["DeepSeek-R1-Distill-Llama-70B-UD-IQ1_S.gguf"],
  "qwen3.6-35b-moe": ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"],
  "deepseek-r1-8b": ["deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf"],
  "gemma-4-12b": ["gemma-4-12b-it-Q4_K_M.gguf"],
};

// Search paths for models
const SEARCH_PATHS = [
  "/Users/yaeger/Desktop/swarmagents-models/models",
  "/Users/yaeger/Desktop/swarmagents-models",
  "~/ai/models",
  "./swarmagents-models",
  "./models",
  "/opt/models",
];

function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME || "/Users/yaeger", p.slice(2));
  }
  return p;
}

export function discoverModels(): GGUFModel[] {
  const found: GGUFModel[] = [];

  for (const modelDef of MODEL_REGISTRY) {
    const patterns = MODEL_FILE_PATTERNS[modelDef.id] || [];
    let modelPath = "";
    let sizeBytes = 0;

    for (const searchPath of SEARCH_PATHS) {
      const dir = resolvePath(searchPath);
      if (!existsSync(dir)) continue;

      for (const pattern of patterns) {
        const fullPath = path.join(dir, pattern);
        if (existsSync(fullPath)) {
          try {
            const stats = statSync(fullPath);
            if (stats.size > 1000) { // Exclude stubs (yaeger-1b is 106 bytes)
              modelPath = fullPath;
              sizeBytes = stats.size;
              break;
            }
          } catch { /* ignore */ }
        }
      }
      if (modelPath) break;
    }

    found.push({
      ...modelDef,
      path: modelPath,
      sizeBytes,
      sizeGB: Math.round((sizeBytes / 1024 / 1024 / 1024) * 10) / 10,
      available: !!modelPath,
    });
  }

  return found;
}

// ─── Task-to-Model Routing ─────────────────────────────────────────

const TASK_TYPE_PATTERNS: Record<string, RegExp[]> = {
  reasoning: [
    /\barchitect|design pattern|system design|framework|abstract\b/i,
    /\bproof|theorem|lemma|verify|formal verification|mathematical\b/i,
    /\bplan|strategy|roadmap|decompose|break down\b/i,
    /\banalyze|evaluate|compare|trade.off|optimize\b/i,
    /\bcoordination|orchestration|multi.agent|swarm\b/i,
    /\bdebug|troubleshoot|root cause|investigate\b/i,
    /\breason|infer|deduce|synthesize|critique\b/i,
    /\bexplain|why|how does|what if\b/i,
  ],
  coding: [
    /\bimplement|build|create|develop|write code\b/i,
    /\brefactor|restructure|migrate|upgrade\b/i,
    /\bfunction|class|module|component\b/i,
    /\bbug|fix|error|exception|stack trace\b/i,
    /\bpython|javascript|typescript|rust|go\b/i,
  ],
  execution: [
    /\brun|execute|call|invoke|trigger\b/i,
    /\bprint|log|output|display|format\b/i,
    /\bedit|fix|patch|update|change\b/i,
    /\bsummarize|list|enumerate|extract\b/i,
    /\bfile|path|directory|copy|move\b/i,
    /\btest|validate|assert|benchmark\b/i,
  ],
  creative: [
    /\bcreate|generate|write|draft|compose\b/i,
    /\bstory|narrative|dialogue|script\b/i,
    /\bdesign|ui|ux|visual|layout\b/i,
  ],
};

function classifyTaskType(task: string): string {
  const text = task.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [type, patterns] of Object.entries(TASK_TYPE_PATTERNS)) {
    scores[type] = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) scores[type] += 1;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : "general";
}

export function selectModelForTask(
  task: string,
  models: GGUFModel[]
): { model: GGUFModel | null; reason: string } {
  const available = models.filter((m) => m.available);
  if (!available.length) {
    return { model: null, reason: "No models available on this system." };
  }

  const taskType = classifyTaskType(task);

  // Sort by relevance to task type
  const scored = available.map((m) => {
    let score = 0;
    const strengths = m.strengths.map((s) => s.toLowerCase());

    // Task type matching
    if (taskType === "reasoning" && strengths.some((s) => s.includes("reason"))) score += 10;
    if (taskType === "coding" && strengths.some((s) => s.includes("code"))) score += 10;
    if (taskType === "execution" && strengths.some((s) => s.includes("fast") || s.includes("tool"))) score += 10;
    if (taskType === "creative" && strengths.some((s) => s.includes("general"))) score += 5;

    // Prefer larger models for reasoning, smaller for execution
    const paramCount = parseFloat(m.parameters.replace("B", ""));
    if (taskType === "reasoning") score += paramCount;
    if (taskType === "execution") score -= paramCount * 0.5;

    // Prefer yaeger models for swarm-specific tasks
    if (/\bswarm|agent|orchestrat\b/i.test(task) && m.id.startsWith("yaeger")) score += 5;

    return { model: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  return {
    model: best.model,
    reason: `Task type: ${taskType}. Selected ${best.model.name} (${best.model.parameters}) based on ${best.model.strengths.slice(0, 2).join(", ")}.`,
  };
}

// ─── Inference ───────────────────────────────────────────────────────

export interface InferenceOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  modelPath?: string;
}

export interface InferenceResult {
  content: string;
  model: string;
  tokensUsed?: number;
  latencyMs: number;
  error?: string;
}

/** Run inference via yaeger_server.py subprocess */
export async function runInference(opts: InferenceOptions): Promise<InferenceResult> {
  const start = Date.now();

  // Check if yaeger_server.py is available
  const yaegerServerPath = "/Users/yaeger/ai/yaeger_server.py";
  if (!existsSync(yaegerServerPath)) {
    return {
      content: "",
      model: "none",
      latencyMs: Date.now() - start,
      error: "Yaeger server not found at " + yaegerServerPath,
    };
  }

  // Check if model path is provided or we need to discover
  const modelPath = opts.modelPath || "/Users/yaeger/ai/models/yaeger-16.9b-q4_k_m.gguf";
  if (!existsSync(modelPath)) {
    return {
      content: "",
      model: "none",
      latencyMs: Date.now() - start,
      error: `Model not found: ${modelPath}`,
    };
  }

  return new Promise((resolve) => {
    const env = { ...process.env, YAEGER_MODEL_PATH: modelPath };
    const child = spawn("python3", [yaegerServerPath, modelPath], {
      env,
      cwd: "/Users/yaeger/ai",
    });

    let output = "";
    let error = "";

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      error += data.toString();
    });

    // Kill after timeout
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        content: output || "",
        model: path.basename(modelPath),
        latencyMs: Date.now() - start,
        error: error || "Inference timeout (30s)",
      });
    }, 30000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        content: output || "",
        model: path.basename(modelPath),
        latencyMs: Date.now() - start,
        error: code !== 0 ? (error || `Exit code ${code}`) : undefined,
      });
    });
  });
}

/** Run inference via Ollama if models are registered there */
export async function runOllamaInference(
  modelName: string,
  messages: Array<{ role: string; content: string }>,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<InferenceResult> {
  const start = Date.now();

  try {
    const res = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: opts?.temperature ?? 0.7,
        max_tokens: opts?.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      return {
        content: "",
        model: modelName,
        latencyMs: Date.now() - start,
        error: `Ollama error: ${res.status} ${await res.text()}`,
      };
    }

    const data = await res.json();
    return {
      content: data.choices?.[0]?.message?.content || "",
      model: modelName,
      tokensUsed: data.usage?.total_tokens,
      latencyMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      content: "",
      model: modelName,
      latencyMs: Date.now() - start,
      error: `Ollama connection failed: ${e.message}`,
    };
  }
}
