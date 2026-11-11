/**
 * Lightweight codebase heatmap for spawn bias + search focus.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { DecompSessionRecord } from '@/lib/decompSessions';
import type { BlackboardPost } from '@/lib/sessionBlackboard';

export type HeatEntry = {
  path: string;
  score: number;
  reasons: string[];
};

const SKIP = new Set(['.swarm', 'node_modules', '.git', '.next', 'dist', '__pycache__']);

async function listFiles(root: string, max = 200): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix = '') => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      if (SKIP.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), rel);
      else out.push(rel);
    }
  };
  await walk(root);
  return out;
}

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

export async function buildCodebaseHeatmap(
  workspace: string,
  session: DecompSessionRecord,
  blackboard: BlackboardPost[] = []
): Promise<HeatEntry[]> {
  const files = await listFiles(workspace, 250);
  const scores = new Map<string, { score: number; reasons: string[] }>();

  const bump = (p: string, amount: number, reason: string) => {
    if (!p || p.includes('..')) return;
    const cur = scores.get(p) || { score: 0, reasons: [] };
    cur.score += amount;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    scores.set(p, cur);
  };

  const leaves = collectLeaves(session.nodes || []);
  for (const leaf of leaves) {
    const pending = !['completed', 'failed'].includes(String(leaf.status));
    if (leaf.deliverable_path) {
      bump(String(leaf.deliverable_path), pending ? 8 : 2, pending ? 'pending_leaf' : 'done_leaf');
    }
    if (Array.isArray(leaf.files_written)) {
      for (const f of leaf.files_written) bump(String(f), 3, 'written');
    }
    if (pending && leaf.acceptance_criteria?.length) {
      const guess = String(leaf.deliverable_path || `src/${String(leaf.id || 'leaf').slice(0, 20)}`);
      bump(guess, 4, 'acceptance_open');
    }
  }

  for (const post of blackboard) {
    if (post.path) bump(post.path, post.kind === 'blocker' ? 6 : 2, `bb_${post.kind}`);
    for (const f of files) {
      const base = f.split('/').pop() || '';
      if (base && post.text?.includes(base)) bump(f, 1, 'bb_mention');
    }
  }

  // Prefer src/ and deliverables/ structure
  for (const f of files) {
    if (f.startsWith('src/')) bump(f, 1, 'src_tree');
    if (f.startsWith('deliverables/')) bump(f, 1, 'deliverable');
    // lightweight "centrality": files imported/mentioned in many paths get a nudge via basename reuse
    const base = f.split('/').pop() || '';
    if (base && files.filter((x) => x.includes(base)).length > 2) bump(f, 1, 'name_centrality');
  }

  // mtime recency
  for (const f of files.slice(0, 120)) {
    try {
      const st = await fs.stat(path.join(workspace, f));
      const ageMin = (Date.now() - st.mtimeMs) / 60000;
      if (ageMin < 30) bump(f, 4, 'recent_edit');
      else if (ageMin < 180) bump(f, 2, 'recent_edit');
    } catch {
      /* skip */
    }
  }

  const entries: HeatEntry[] = [...scores.entries()]
    .map(([p, v]) => ({ path: p, score: v.score, reasons: v.reasons }))
    .sort((a, b) => b.score - a.score);

  (session as { heatmap?: HeatEntry[] }).heatmap = entries.slice(0, 40);
  return entries;
}

export function topHotspots(entries: HeatEntry[], n = 8): string[] {
  return entries.slice(0, n).map((e) => e.path);
}

export function heatmapHintForPrompt(entries: HeatEntry[], n = 5): string {
  const top = entries.slice(0, n);
  if (!top.length) return '';
  return (
    'Heatmap (work here first):\n' +
    top.map((e) => `- ${e.path} (score=${e.score}: ${e.reasons.slice(0, 3).join(',')})`).join('\n')
  );
}
