/**
 * Cockpit control actions. Each one shows an honest lifecycle:
 * sending → sent (HTTP accepted) → acked (matching event on the stream).
 */

import { postControl } from '@/hooks/useRunStream';
import type { ControlName, RunStore } from '@/stores/runStore';

export async function sendControl(store: RunStore, name: ControlName, body?: unknown): Promise<boolean> {
  const at = Date.now();
  store.setControl(name, { phase: 'sending', sentAfterSeq: store.d.lastSeq, at });
  try {
    await postControl(store.runId, `/${name}`, body);
    const cur = store.controls[name];
    // the ack event may already have arrived while the POST was in flight
    if (cur?.phase !== 'acked') store.setControl(name, { phase: 'sent', sentAfterSeq: store.d.lastSeq, at });
    return true;
  } catch (e) {
    store.setControl(name, { phase: 'error', sentAfterSeq: store.d.lastSeq, at, error: (e as Error).message });
    return false;
  }
}

let steerCounter = 0;

export async function sendSteer(store: RunStore, text: string, interrupt = false): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  const localId = `local-${Date.now()}-${steerCounter++}`;
  store.upsertSteer({ localId, text: t, phase: 'sending', interrupt, at: Date.now() });
  try {
    const res = (await postControl(
      store.runId,
      interrupt ? '/interrupt' : '/steer',
      // `text` is the v2 contract; `instruction` keeps pre-v2 engines working.
      interrupt ? { text: t } : { text: t, instruction: t },
    )) as Record<string, unknown> | undefined;
    const sid = res && typeof res === 'object' ? (res.steer_id ?? res.id) : undefined;
    const cur = store.steersLocal.find((s) => s.localId === localId);
    if (cur && cur.phase === 'sending') {
      store.upsertSteer({ ...cur, phase: 'sent', serverId: sid != null ? String(sid) : undefined });
    }
    if (interrupt) {
      const c = store.controls.interrupt;
      if (c?.phase !== 'acked') store.setControl('interrupt', { phase: 'sent', sentAfterSeq: store.d.lastSeq, at: Date.now() });
    }
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    store.upsertSteer({ localId, text: t, phase: 'error', interrupt, error: /^40[45]/.test(msg) && interrupt ? 'engine has no /interrupt endpoint yet' : msg, at: Date.now() });
    return false;
  }
}

export async function resolveApproval(store: RunStore, id: string, decision: 'approve' | 'reject'): Promise<boolean> {
  store.setApprovalLocal(id, { phase: 'sending', decision });
  try {
    await postControl(store.runId, `/approvals/${encodeURIComponent(id)}`, { decision });
    if (store.approvalsLocal[id]) store.setApprovalLocal(id, { phase: 'sent', decision });
    return true;
  } catch (e) {
    store.setApprovalLocal(id, { phase: 'error', decision, error: (e as Error).message });
    return false;
  }
}
