// ────────────────────────────────────────────────────────────
//  AgentBrain — pluggable decision provider for arena agents
// ────────────────────────────────────────────────────────────
//
// Every brain takes a perception snapshot and returns an action plus
// a rationale string. The schema mirrors the Hamiltonian LoRA we trained:
//
//   input  = { S_t, S_g, momentum, available_actions }
//   output = { optimal_action, rationale }
//
// That means once your trained GGUF runs in Ollama, you can wire it up
// here with zero code changes to the arena itself.

export type Vec3 = { x: number; y: number; z: number };

export interface Interactable {
  id: string;
  kind: 'tv' | 'couch' | 'table' | 'plant' | 'cup' | 'ball' | 'drone' | 'agent' | 'glass_wall' | 'door';
  position: Vec3;
  state?: Record<string, unknown>;
  /** Higher = more interesting to a curious agent (0–1) */
  novelty?: number;
  /** Free-form tags (e.g. 'broken', 'on_fire') */
  notes?: string;
}

export interface AgentPerception {
  /** Self-state (matches S_t in the LoRA schema) */
  S_t: {
    id: string;
    label: string;
    position: Vec3;
    facing: number;          // yaw in radians
    holding: string | null;  // id of held interactible, if any
    mood: 'curious' | 'bored' | 'agitated' | 'focused' | 'amused';
    energy: number;          // 0–1
    location_label: 'couch' | 'floor' | 'near_tv' | 'near_glass' | 'outside' | 'unknown';
  };

  /** Goal state (S_g) */
  S_g: {
    objective: 'explore' | 'interact' | 'escape' | 'socialize' | 'idle' | 'observe';
    target_id?: string;
    description: string;
  };

  /** Recent action sequence — momentum / habit signal */
  momentum: string[];

  /** Everything visible right now */
  visible: Interactable[];

  /** Tick number (for time-based reasoning) */
  tick: number;
}

export type ActionType =
  | 'idle'
  | 'walk_to'
  | 'sit_on'
  | 'stand_up'
  | 'pickup'
  | 'drop'
  | 'throw'
  | 'change_channel'
  | 'speak'
  | 'observe'
  | 'try_escape'
  | 'punch_glass';

export interface AgentAction {
  type: ActionType;
  /** Target interactible id, if any */
  target_id?: string;
  /** Free-form payload (e.g. utterance text, throw direction) */
  args?: Record<string, unknown>;
  /** Why the brain picked this — shown above the agent as a speech bubble */
  rationale: string;
}

export interface BrainInfo {
  id: string;
  label: string;
  description: string;
  /** Is this brain free of network calls? */
  local: boolean;
}

export interface AgentBrain {
  info: BrainInfo;
  /** Decide what to do next, given a perception snapshot */
  decide(perception: AgentPerception): Promise<AgentAction>;
}

// ────────────────────────────────────────────────────────────
//  Reflex brain — utility-AI / hardcoded heuristics
// ────────────────────────────────────────────────────────────
export class ReflexBrain implements AgentBrain {
  info: BrainInfo = {
    id: 'reflex',
    label: 'Reflex',
    description: 'Hardcoded utility AI: pursue most novel interactable; sit when tired; throw when bored.',
    local: true,
  };

  async decide(p: AgentPerception): Promise<AgentAction> {
    const { S_t, momentum, visible } = p;

    // 1. If holding something + we just walked, probability of throwing
    if (S_t.holding && momentum.slice(-2).every(a => a === 'walk_to')) {
      const target = visible.find(v => v.kind === 'glass_wall' || v.kind === 'tv');
      if (target) {
        return {
          type: 'throw',
          target_id: target.id,
          rationale: `Holding ${S_t.holding}. Let's see what happens if I throw it at the ${target.kind}.`,
        };
      }
      return { type: 'drop', rationale: 'Lost interest. Dropping it.' };
    }

    // 2a. If seated and energy restored, stand up
    if (S_t.location_label === 'couch' && S_t.energy > 0.5) {
      return { type: 'stand_up', rationale: 'Rested enough. Time to explore again.' };
    }
    // 2b. If low energy, sit on the couch
    if (S_t.energy < 0.2 && S_t.location_label !== 'couch') {
      const couch = visible.find(v => v.kind === 'couch');
      if (couch) return { type: 'walk_to', target_id: couch.id, rationale: 'Energy low. Heading to the couch.' };
    }

    // 3. Pick the most novel target we haven't visited recently
    const recent = new Set(momentum.slice(-5));
    const candidates = visible
      .filter(v => !recent.has(`walk_to:${v.id}`))
      .sort((a, b) => (b.novelty ?? 0.5) - (a.novelty ?? 0.5));

    if (candidates.length === 0) {
      return { type: 'observe', rationale: 'Nothing new in here. Looking around.' };
    }

    const target = candidates[0];

    // 4. If we're already near a TV, change channel for fun
    if (target.kind === 'tv' && S_t.location_label === 'near_tv') {
      return { type: 'change_channel', target_id: target.id, rationale: 'Bored of this channel. Flip.' };
    }
    // 5. If a small object is nearby + we have empty hands, pick it up
    if ((target.kind === 'cup' || target.kind === 'ball') && !S_t.holding) {
      const d = dist(S_t.position, target.position);
      if (d < 1.5) return { type: 'pickup', target_id: target.id, rationale: `That ${target.kind} looks fun.` };
    }

    return { type: 'walk_to', target_id: target.id, rationale: `Curious about that ${target.kind}.` };
  }
}

// ────────────────────────────────────────────────────────────
//  Hamiltonian brain — calls a model that follows our schema
// ────────────────────────────────────────────────────────────
//   Works with Ollama out-of-the-box if you create a Modelfile pointing
//   to the q4_k_m GGUF we exported. The agent posts the schema's input
//   and parses { optimal_action, rationale } from the response.

export interface HamiltonianBrainConfig {
  /** Endpoint URL. Default: local Ollama. */
  endpoint?: string;
  /** Model name registered with the endpoint */
  model?: string;
  /** API key for non-local providers (Bearer / x-api-key) */
  apiKey?: string;
  /** Custom fetch (for testing / proxying) */
  fetcher?: typeof fetch;
  /** How long before falling back to reflex */
  timeoutMs?: number;
}

export class HamiltonianBrain implements AgentBrain {
  info: BrainInfo;
  private cfg: Required<HamiltonianBrainConfig>;
  private fallback = new ReflexBrain();

  constructor(cfg: HamiltonianBrainConfig = {}) {
    this.cfg = {
      endpoint: cfg.endpoint ?? 'http://localhost:11434/api/generate',
      model:    cfg.model    ?? 'swarmagents-hamiltonian',
      apiKey:   cfg.apiKey   ?? '',
      fetcher:  cfg.fetcher  ?? (typeof fetch !== 'undefined' ? fetch : (() => { throw new Error('no fetch'); }) as any),
      timeoutMs: cfg.timeoutMs ?? 9000,
    };
    this.info = {
      id: 'hamiltonian',
      label: `LLM · ${this.cfg.model}`,
      description: 'Decision proxied through /api/hamiltonian/decide to your chosen model. Falls back to reflex on error/timeout.',
      local: this.cfg.endpoint.includes('localhost') || this.cfg.endpoint.includes('127.0.0.1'),
    };
  }

  async decide(p: AgentPerception): Promise<AgentAction> {
    const available = buildAvailableActions(p);
    const availStrings = available.map(a => describeAction(a));
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);

    try {
      // Always proxy through our /api/hamiltonian/decide route so the browser doesn't
      // hit CORS / mixed-content. The proxy forwards to the chosen upstream provider.
      const res = await this.cfg.fetcher('/api/hamiltonian/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: {
            S_t: p.S_t,
            S_g: p.S_g,
            momentum: p.momentum,
            available_actions: availStrings,
          },
          endpoint: this.cfg.endpoint,
          model: this.cfg.model,
          apiKey: this.cfg.apiKey || undefined,
        }),
        signal: ctl.signal,
      });
      if (res.ok) {
        const data = await res.json() as { optimal_action?: string; rationale?: string; error?: string };
        if (data.optimal_action) {
          const [type, target_id] = data.optimal_action.split(':') as [any, string | undefined];
          const match = available.find(a => a.type === type && (a.target_id ?? '') === (target_id ?? ''));
          if (match) return { ...match, rationale: data.rationale ?? '' };
        }
      }
    } catch {
      /* fall through */
    } finally {
      clearTimeout(t);
    }

    // Fallback so the agent never freezes
    const fb = await this.fallback.decide(p);
    return { ...fb, rationale: `[reflex fallback] ${fb.rationale}` };
  }
}

// ────────────────────────────────────────────────────────────
//  RandomBrain — chaos demo
// ────────────────────────────────────────────────────────────
export class RandomBrain implements AgentBrain {
  info: BrainInfo = { id: 'random', label: 'Chaos', description: 'Picks a random valid action every tick.', local: true };
  async decide(p: AgentPerception): Promise<AgentAction> {
    const available = buildAvailableActions(p);
    const pick = available[Math.floor(Math.random() * available.length)];
    return { ...pick, rationale: 'Why not.' };
  }
}

// ────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────
export function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function buildAvailableActions(p: AgentPerception): AgentAction[] {
  const list: AgentAction[] = [
    { type: 'idle',    rationale: '' },
    { type: 'observe', rationale: '' },
  ];
  if (p.S_t.holding) {
    list.push({ type: 'drop', rationale: '' });
    for (const v of p.visible) {
      if (v.kind === 'glass_wall' || v.kind === 'tv') {
        list.push({ type: 'throw', target_id: v.id, rationale: '' });
      }
    }
  }
  for (const v of p.visible) {
    list.push({ type: 'walk_to', target_id: v.id, rationale: '' });
    if (!p.S_t.holding && (v.kind === 'cup' || v.kind === 'ball')) {
      list.push({ type: 'pickup', target_id: v.id, rationale: '' });
    }
    if (v.kind === 'tv') list.push({ type: 'change_channel', target_id: v.id, rationale: '' });
    if (v.kind === 'couch') list.push({ type: 'sit_on', target_id: v.id, rationale: '' });
  }
  if (p.S_t.location_label === 'couch') {
    list.push({ type: 'stand_up', rationale: '' });
  }
  if (p.S_t.location_label === 'near_glass') {
    list.push({ type: 'punch_glass', rationale: '' });
    list.push({ type: 'try_escape',  rationale: '' });
  }
  return list;
}

function buildPrompt(p: AgentPerception, available: AgentAction[]): string {
  const input = {
    S_t: p.S_t,
    S_g: p.S_g,
    momentum: p.momentum,
    available_actions: available.map(a => describeAction(a)),
  };
  return [
    'You are a Hamiltonian agent embedded in a 3D office sandbox. Decide the optimal next action.',
    'Return strictly valid JSON: { "optimal_action": "<one of available_actions>", "rationale": "<one sentence>" }.',
    '',
    'Input:',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

function describeAction(a: AgentAction): string {
  if (a.target_id) return `${a.type}:${a.target_id}`;
  return a.type;
}

function parseHamiltonianResponse(text: string, available: AgentAction[]): AgentAction | null {
  // Try to extract a JSON blob
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { optimal_action?: string; rationale?: string };
    if (!obj.optimal_action) return null;
    // Resolve the action string back to one of our actions
    const [type, target_id] = obj.optimal_action.split(':') as [ActionType, string | undefined];
    const match = available.find(a => a.type === type && (a.target_id ?? '') === (target_id ?? ''));
    if (!match) return null;
    return { ...match, rationale: obj.rationale ?? '' };
  } catch {
    return null;
  }
}
