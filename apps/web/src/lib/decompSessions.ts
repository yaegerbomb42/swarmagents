/**
 * Shared decomposition session store (memory + disk for long-horizon durability).
 * Used by /api/tasks/decompose and /api/tasks/steer in the same Next.js process.
 */

import fsSync, { promises as fs } from 'fs';
import path from 'path';

export type SteerStatus = 'applied' | 'queued' | 'rejected' | 'partial';

export type SteerAction =
  | 'message'
  | 'pause'
  | 'resume'
  | 'pause_node'
  | 'resume_node'
  | 're_decompose'
  | 'inject_leaf'
  | 'spawn_leaf'
  | 'skip_leaf'
  | 'merge_nodes'
  | 'set_quality'
  | 'prefer'
  | 'avoid'
  | 'cancel_node';

export interface SteerDirective {
  id: string;
  action: SteerAction;
  message?: string;
  nodeId?: string;
  payload?: Record<string, unknown>;
  status: SteerStatus;
  affectedNodeIds: string[];
  response: string;
  engineOnline: boolean;
  timestamp: string;
}

export interface DecompSessionRecord {
  id: string;
  project: string;
  mission?: {
    title?: string;
    domain?: string;
    vague?: boolean;
    constraints?: string[];
  };
  decomp_meta?: {
    source?: 'llm' | 'fallback' | string;
    llmError?: string | null;
    recovered?: boolean;
    domain?: string;
    repair?: Record<string, unknown>;
    [key: string]: unknown;
  };
  timeRequirement: string;
  budget_minutes?: number;
  target_leaves?: number;
  nodes: any[];
  project_title: string;
  total_effort: string;
  status: string;
  createdAt: number;
  fit?: unknown;
  summary?: unknown;
  auto_deepen?: {
    enabled: boolean;
    deepenCalls?: number;
    rounds?: number;
    done?: boolean;
  };
  progress?: {
    phase?: string;
    round?: number;
    deepenCalls?: number;
    leafCount?: number;
    targetLeaves?: number;
    message?: string;
    [key: string]: unknown;
  };
  /** Swarm-level pause */
  paused?: boolean;
  /** Soft constraints from steering */
  constraints?: {
    prefer: string[];
    avoid: string[];
    qualityBar?: 'low' | 'medium' | 'high' | 'strict';
  };
  /** Applied / queued steer history */
  steerLog?: SteerDirective[];
  /** Long-horizon runtime (milestones, checkpoints, role allocation) */
  runtime?: unknown;
  watcher?: unknown;
  organizer?: unknown;
  seats?: unknown;
  /** Owning auth user id (for restore across navigations / reloads) */
  ownerUserId?: string;
  updatedAt?: number;
  [key: string]: unknown;
}

const g = globalThis as typeof globalThis & {
  __swarmDecompSessions?: Map<string, DecompSessionRecord>;
};

if (!g.__swarmDecompSessions) {
  g.__swarmDecompSessions = new Map();
}

export const decompSessions = g.__swarmDecompSessions;

const SESSION_DIR = path.join(process.cwd(), '.data', 'decomp-sessions');
const USER_INDEX_DIR = path.join(SESSION_DIR, 'by-user');

function sessionPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return path.join(SESSION_DIR, `${safe}.json`);
}

function userIndexPath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 120);
  return path.join(USER_INDEX_DIR, `${safe}.json`);
}

type UserSessionIndex = {
  activeSessionId: string | null;
  recent: Array<{ id: string; title: string; updatedAt: number; status?: string }>;
};

async function loadUserIndex(userId: string): Promise<UserSessionIndex> {
  try {
    const raw = await fs.readFile(userIndexPath(userId), 'utf8');
    const parsed = JSON.parse(raw) as UserSessionIndex;
    return {
      activeSessionId: parsed.activeSessionId || null,
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
    };
  } catch {
    return { activeSessionId: null, recent: [] };
  }
}

async function saveUserIndex(userId: string, index: UserSessionIndex): Promise<void> {
  try {
    await fs.mkdir(USER_INDEX_DIR, { recursive: true });
    await fs.writeFile(userIndexPath(userId), JSON.stringify(index, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }
}

async function rememberUserSession(session: DecompSessionRecord): Promise<void> {
  const userId = session.ownerUserId;
  if (!userId) return;
  const index = await loadUserIndex(userId);
  const entry = {
    id: session.id,
    title: String(session.project_title || session.project || session.id).slice(0, 120),
    updatedAt: session.updatedAt || Date.now(),
    status: session.status,
  };
  index.activeSessionId = session.id;
  index.recent = [entry, ...index.recent.filter((r) => r.id !== session.id)].slice(0, 20);
  await saveUserIndex(userId, index);
}

async function persistSession(session: DecompSessionRecord): Promise<void> {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.writeFile(sessionPath(session.id), JSON.stringify(session), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rememberUserSession(session);
  } catch {
    /* memory still authoritative for this process */
  }
}

async function loadSessionFromDisk(id: string): Promise<DecompSessionRecord | undefined> {
  try {
    const raw = await fs.readFile(sessionPath(id), 'utf8');
    const parsed = JSON.parse(raw) as DecompSessionRecord;
    if (parsed?.id) {
      decompSessions.set(parsed.id, parsed);
      return parsed;
    }
  } catch {
    /* missing */
  }
  return undefined;
}

export function getSession(id: string): DecompSessionRecord | undefined {
  const mem = decompSessions.get(id);
  if (mem) return mem;
  // Synchronous disk fallback for sync call-sites after container restarts
  try {
    const file = sessionPath(id);
    if (fsSync.existsSync(file)) {
      const raw = fsSync.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as DecompSessionRecord;
      if (parsed?.id) {
        decompSessions.set(parsed.id, parsed);
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Sync get with lazy disk hydrate (best-effort; call hydrateSession for await). */
export function setSession(session: DecompSessionRecord): void {
  session.updatedAt = Date.now();
  decompSessions.set(session.id, session);
  void persistSession(session);
}

export async function hydrateSession(id: string): Promise<DecompSessionRecord | undefined> {
  return getSession(id) || (await loadSessionFromDisk(id));
}

/** Active + recent sessions for an account. */
export async function getUserSessionIndex(userId: string): Promise<UserSessionIndex> {
  return loadUserIndex(userId);
}

export async function hydrateActiveSessionForUser(
  userId: string,
): Promise<DecompSessionRecord | undefined> {
  const index = await loadUserIndex(userId);
  if (!index.activeSessionId) return undefined;
  return hydrateSession(index.activeSessionId);
}

export function findNode(nodes: any[], id: string): any | null {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function collectNodeIds(nodes: any[], predicate: (n: any) => boolean): string[] {
  const ids: string[] = [];
  const walk = (list: any[]) => {
    for (const n of list || []) {
      if (predicate(n)) ids.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

export function ensureConstraints(session: DecompSessionRecord) {
  if (!session.constraints) {
    session.constraints = { prefer: [], avoid: [], qualityBar: 'medium' };
  }
  return session.constraints;
}

export function appendSteerLog(session: DecompSessionRecord, entry: SteerDirective) {
  session.steerLog = [...(session.steerLog || []).slice(-49), entry];
}

/** Parse free-text into a structured steer action when possible. */
export function parseSteerIntent(message: string): {
  action: SteerAction;
  nodeId?: string;
  payload?: Record<string, unknown>;
} {
  const m = message.trim();
  const lower = m.toLowerCase();

  if (
    /\b(pause|halt|hold on|take a break|stop (?:the )?(?:swarm|team|agents|work))\b/i.test(lower) &&
    !/\b(resume|continue|unpause)\b/i.test(lower)
  ) {
    const pauseNode = lower.match(
      /(?:pause|halt)\s+(?:(?:the|this)\s+)?(?:node|task)\s+([a-z0-9_.\-]+)/i
    );
    if (pauseNode) return { action: 'pause_node', nodeId: pauseNode[1] };
    return { action: 'pause' };
  }

  if (/\b(resume|continue|unpause|keep going|start again)\b/i.test(lower)) {
    const resumeNode = lower.match(
      /(?:resume|unpause)\s+(?:(?:the|this)\s+)?(?:node|task)\s+([a-z0-9_.\-]+)/i
    );
    if (resumeNode) return { action: 'resume_node', nodeId: resumeNode[1] };
    return { action: 'resume' };
  }

  const cancelNode = lower.match(
    /(?:cancel|skip|drop|kill)\s+(?:(?:the|this)\s+)?(?:node|task)\s+([a-z0-9_.\-]+)/i
  );
  if (cancelNode) return { action: 'cancel_node', nodeId: cancelNode[1] };

  const redecomp = lower.match(
    /(?:re-?decomp(?:ose)?|split|deepen|break\s+(?:this|it)\s+(?:down|apart))\s+(?:(?:the|this)\s+)?(?:node|task)?\s*([a-z0-9_.\-]+)?/i
  );
  if (/\b(re-?decomp|split (?:this|it)|break (?:this|it) down|deepen)\b/i.test(lower)) {
    return { action: 're_decompose', nodeId: redecomp?.[1] || undefined };
  }

  if (/\b(strict(?:er)?|higher quality|be strict|quality\s*(?:bar)?\s*(?:to|=|:)?\s*strict)\b/i.test(lower)) {
    return { action: 'set_quality', payload: { qualityBar: 'strict' } };
  }
  const quality = lower.match(/\bquality\s*(?:bar)?\s*[:=]?\s*(low|medium|high|strict)\b/i);
  if (quality) {
    return { action: 'set_quality', payload: { qualityBar: quality[1].toLowerCase() } };
  }

  const prefer = m.match(
    /(?:prefer|use|favor|focus on|lean toward|prioritize)\s+(.+)/i
  );
  if (prefer) return { action: 'prefer', payload: { text: prefer[1].trim() } };

  const avoid = m.match(
    /(?:avoid|don't touch|do not touch|leave alone|stay away from|don't change)\s+(.+)/i
  );
  if (avoid) return { action: 'avoid', payload: { text: avoid[1].trim() } };

  const inject = m.match(
    /(?:inject|add(?:\s+(?:a\s+)?(?:leaf|task))?|new task|also do)\s*[:\-]?\s*(.+)/i
  );
  if (inject) {
    return {
      action: 'inject_leaf',
      payload: { label: inject[1].trim() },
    };
  }

  return { action: 'message' };
}
