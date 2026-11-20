/**
 * Registry for synchronous tool-approval handlers.
 *
 * All Claude invocations that run the VM's PreToolUse hook must be able to
 * answer the hook's blocking request. RuntimeManager owns its active run and
 * answers directly; team lanes are not active runtime runs, so their harness
 * registers a handler here for the life of the lane. The hook endpoint falls
 * back to this registry when the run is not the manager's active run (the
 * existing `isActiveRun` already treats a live team lane as active).
 *
 * Keys are run ids (globally unique) and the user id is re-checked on lookup,
 * so one user's lane can never answer another user's call.
 */

import type { ToolApprovalDecision } from "../harness/tool-approval";

export type SynchronousApprovalHandler = (
  toolName: string,
  input: unknown,
) => Promise<ToolApprovalDecision>;

interface Entry {
  userId: string;
  handler: SynchronousApprovalHandler;
}

const handlers = new Map<string, Entry>();

/** Register a lane's handler. Returns an idempotent unregister function. */
export function registerSynchronousApproval(
  runId: string,
  userId: string,
  handler: SynchronousApprovalHandler,
): () => void {
  handlers.set(runId, { userId, handler });
  return () => {
    if (handlers.get(runId)?.handler === handler) handlers.delete(runId);
  };
}

/** The registered handler for this run/user, or null. */
export function requestRegisteredApproval(
  userId: string,
  runId: string,
  toolName: string,
  input: unknown,
): Promise<ToolApprovalDecision> | null {
  const entry = handlers.get(runId);
  if (!entry || entry.userId !== userId) return null;
  return entry.handler(toolName, input);
}

/** Test/reset hook: forget every registered lane. */
export function clearSynchronousApprovalsForTesting(): void {
  handlers.clear();
}
