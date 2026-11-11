/**
 * File-backed session blackboard for concurrent seats.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { DecompSessionRecord } from '@/lib/decompSessions';

export type BlackboardKind = 'thought' | 'decision' | 'blocker' | 'file_ptr' | 'ask';

export type BlackboardPost = {
  id: string;
  at: number;
  kind: BlackboardKind;
  seatId?: string;
  leafId?: string;
  text: string;
  path?: string;
};

function bbPath(workspace: string): string {
  return path.join(workspace, '.swarm', 'blackboard.jsonl');
}

export async function ensureBlackboard(workspace: string): Promise<void> {
  await fs.mkdir(path.join(workspace, '.swarm'), { recursive: true });
  try {
    await fs.access(bbPath(workspace));
  } catch {
    await fs.writeFile(bbPath(workspace), '', 'utf8');
  }
}

export async function postBlackboard(
  workspace: string,
  post: Omit<BlackboardPost, 'id' | 'at'> & { id?: string; at?: number }
): Promise<BlackboardPost> {
  await ensureBlackboard(workspace);
  const full: BlackboardPost = {
    id: post.id || `bb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: post.at || Date.now(),
    kind: post.kind,
    seatId: post.seatId,
    leafId: post.leafId,
    text: String(post.text || '').slice(0, 2000),
    path: post.path,
  };
  await fs.appendFile(bbPath(workspace), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

export async function readBlackboard(
  workspace: string,
  limit = 40
): Promise<BlackboardPost[]> {
  try {
    const raw = await fs.readFile(bbPath(workspace), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const posts: BlackboardPost[] = [];
    for (const line of lines.slice(-Math.max(limit * 2, 80))) {
      try {
        posts.push(JSON.parse(line) as BlackboardPost);
      } catch {
        /* skip */
      }
    }
    return posts.slice(-limit);
  } catch {
    return [];
  }
}

/** Relevant posts for a leaf/seat (keyword + path overlap). */
export function selectRelevantPosts(
  posts: BlackboardPost[],
  opts: { leafLabel?: string; ownsPaths?: string[]; limit?: number }
): BlackboardPost[] {
  const limit = opts.limit ?? 6;
  const label = (opts.leafLabel || '').toLowerCase();
  const paths = (opts.ownsPaths || []).map((p) => p.toLowerCase());
  const scored = posts.map((p) => {
    let score = 0;
    const t = (p.text || '').toLowerCase();
    if (p.kind === 'blocker' || p.kind === 'decision') score += 2;
    if (label && t.includes(label.slice(0, 24))) score += 3;
    if (p.path && paths.some((x) => p.path!.toLowerCase().includes(x) || x.includes(p.path!.toLowerCase()))) {
      score += 4;
    }
    if (paths.some((x) => t.includes(x))) score += 2;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score || b.p.at - a.p.at);
  const top = scored.filter((x) => x.score > 0).slice(0, limit).map((x) => x.p);
  if (top.length) return top;
  return posts.slice(-limit);
}

export function formatBlackboardForPrompt(posts: BlackboardPost[]): string {
  if (!posts.length) return '';
  return (
    'Blackboard (shared team notes):\n' +
    posts
      .map((p) => `- [${p.kind}] ${p.text.slice(0, 180)}${p.path ? ` @${p.path}` : ''}`)
      .join('\n')
  );
}

export function syncBlackboardToSession(
  session: DecompSessionRecord,
  posts: BlackboardPost[]
): void {
  (session as { blackboard?: { posts: BlackboardPost[]; count: number } }).blackboard = {
    posts: posts.slice(-30),
    count: posts.length,
  };
}

export async function loadSessionBlackboard(
  session: DecompSessionRecord,
  workspace: string
): Promise<BlackboardPost[]> {
  const posts = await readBlackboard(workspace, 50);
  syncBlackboardToSession(session, posts);
  return posts;
}
