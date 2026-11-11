/**
 * Pure dynamic seat spawner — invents company seats at runtime.
 * No predefined role catalog as the control plane.
 */

import type { DecompSessionRecord } from '@/lib/decompSessions';

export type SeatStatus = 'idle' | 'working' | 'blocked' | 'retired';

export type Seat = {
  id: string;
  title: string;
  mission: string;
  tools: string[];
  ownsPaths: string[];
  leafIds: string[];
  status: SeatStatus;
  providerId?: string;
  spawnedAt: number;
  lastActiveAt: number;
};

const VERB_HINTS: Array<{ re: RegExp; title: string; tools: string[] }> = [
  { re: /test|qa|verify|accept/i, title: 'QA hunter', tools: ['shell', 'file_read', 'file_write'] },
  { re: /research|discover|survey|doc/i, title: 'researcher', tools: ['search', 'file_read', 'shell'] },
  { re: /arch|design|contract|schema/i, title: 'architect', tools: ['file_write', 'file_read', 'search'] },
  { re: /debug|fix|error|bug/i, title: 'debugger', tools: ['shell', 'file_read', 'file_write'] },
  { re: /ui|frontend|css|react|page/i, title: 'UI engineer', tools: ['file_write', 'file_read', 'shell'] },
  { re: /api|backend|server|db|auth/i, title: 'backend engineer', tools: ['file_write', 'shell', 'file_read'] },
];

function collectLeaves(nodes: any[]): any[] {
  const leaves: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list || []) {
      const kids = n.children || [];
      if (!kids.length && (n.type === 'task' || n.type === 'leaf' || !n.type)) leaves.push(n);
      else if (kids.length) walk(kids);
      else leaves.push(n);
    }
  };
  walk(nodes || []);
  return leaves;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function inventTitle(leaf: any, hotspot?: string): string {
  const label = String(leaf.label || leaf.description || leaf.id || 'task');
  const short = label.replace(/\s+/g, ' ').trim().slice(0, 42);
  for (const h of VERB_HINTS) {
    if (h.re.test(label) || (hotspot && h.re.test(hotspot))) {
      return `${short} · ${h.title}`;
    }
  }
  return `${short} · engineer`;
}

function inventTools(leaf: any): string[] {
  const label = String(leaf.label || leaf.description || '');
  for (const h of VERB_HINTS) {
    if (h.re.test(label)) return h.tools;
  }
  return ['file_write', 'file_read', 'shell_exec', 'file_list'];
}

function ownsPathsFor(leaf: any, hotspots: string[]): string[] {
  const paths: string[] = [];
  if (leaf.deliverable_path) paths.push(String(leaf.deliverable_path));
  if (Array.isArray(leaf.files_written)) {
    for (const f of leaf.files_written.slice(0, 4)) paths.push(String(f));
  }
  for (const h of hotspots.slice(0, 3)) {
    if (!paths.includes(h)) paths.push(h);
  }
  if (!paths.length) paths.push('src/');
  return paths.slice(0, 8);
}

/** Soft max seats: ramp toward 100 as the tree grows. */
export function softMaxSeats(session: DecompSessionRecord): number {
  const configured = Number((session as { maxSeats?: number }).maxSeats);
  if (configured > 0) return Math.min(100, configured);
  const leaves = collectLeaves(session.nodes || []);
  const pending = leaves.filter((n) => !['completed', 'failed'].includes(String(n.status))).length;
  const budget = Number(session.budget_minutes) || 60;
  if (budget >= 1440 || pending >= 80) return 100;
  if (budget >= 180 || pending >= 40) return 32;
  if (pending >= 16) return 16;
  return 8;
}

export function getSeats(session: DecompSessionRecord): Seat[] {
  const raw = (session as { seats?: Seat[] }).seats;
  return Array.isArray(raw) ? raw : [];
}

function setSeats(session: DecompSessionRecord, seats: Seat[]): void {
  (session as { seats?: Seat[] }).seats = seats;
}

/**
 * Ensure live seats cover pending leaves. Invents titles; retires done seats.
 */
export function ensureSeats(
  session: DecompSessionRecord,
  opts?: { hotspots?: string[]; blackboardHints?: string[] }
): Seat[] {
  const hotspots = opts?.hotspots || [];
  const leaves = collectLeaves(session.nodes || []);
  const pending = leaves.filter(
    (n) => n.status !== 'completed' && n.status !== 'failed' && n.status !== 'running'
  );
  const max = softMaxSeats(session);
  let seats = getSeats(session).filter((s) => s.status !== 'retired');

  // Retire seats whose leaves are all done
  const leafById = new Map(leaves.map((l) => [l.id, l]));
  for (const seat of seats) {
    const still = seat.leafIds.filter((id) => {
      const n = leafById.get(id);
      return n && !['completed', 'failed'].includes(String(n.status));
    });
    if (!still.length && seat.leafIds.length) {
      seat.status = 'retired';
      seat.leafIds = [];
    } else {
      seat.leafIds = still.length ? still : seat.leafIds;
    }
  }
  seats = seats.filter((s) => s.status !== 'retired');

  // Assign unseated pending leaves
  const seated = new Set(seats.flatMap((s) => s.leafIds));
  const unseated = pending.filter((l) => !seated.has(l.id));

  for (const leaf of unseated) {
    if (seats.length >= max) break;
    // Try attach to existing seat with overlapping path
    const path = String(leaf.deliverable_path || '');
    const existing = seats.find(
      (s) =>
        s.status !== 'working' &&
        s.leafIds.length < 3 &&
        path &&
        s.ownsPaths.some((p) => path.startsWith(p) || p.startsWith(path))
    );
    if (existing) {
      existing.leafIds.push(leaf.id);
      existing.lastActiveAt = Date.now();
      leaf.assignedSeatId = existing.id;
      leaf.assignedAgent = existing.title;
      continue;
    }

    const title = inventTitle(leaf, hotspots[0]);
    const id = `seat-${slug(title)}-${leaf.id}`.slice(0, 80);
    const seat: Seat = {
      id,
      title,
      mission: String(leaf.description || leaf.label || title).slice(0, 400),
      tools: inventTools(leaf),
      ownsPaths: ownsPathsFor(leaf, hotspots),
      leafIds: [leaf.id],
      status: 'idle',
      spawnedAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    if (opts?.blackboardHints?.length) {
      seat.mission += ` | BB: ${opts.blackboardHints.slice(0, 2).join('; ')}`.slice(0, 500);
    }
    seats.push(seat);
    leaf.assignedSeatId = seat.id;
    leaf.assignedAgent = seat.title;
  }

  // Cap
  if (seats.length > max) {
    const keep = seats.slice(0, max);
    setSeats(session, keep);
    return keep;
  }

  setSeats(session, seats);
  (session as { maxSeats?: number }).maxSeats = max;
  return seats;
}

export function markSeatWorking(session: DecompSessionRecord, seatId: string): void {
  const seats = getSeats(session);
  const s = seats.find((x) => x.id === seatId);
  if (s) {
    s.status = 'working';
    s.lastActiveAt = Date.now();
  }
}

export function markSeatIdle(session: DecompSessionRecord, seatId: string): void {
  const seats = getSeats(session);
  const s = seats.find((x) => x.id === seatId);
  if (s && s.status === 'working') {
    s.status = 'idle';
    s.lastActiveAt = Date.now();
  }
}
