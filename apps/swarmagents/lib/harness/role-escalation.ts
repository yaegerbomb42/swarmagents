/**
 * Role-escalation approvals.
 *
 * A run's role policy only admits the starting role and roles that are a
 * capability subset of it (plus the user's explicit pre-grants). A switch to
 * anything broader — one that adds a permission, tool or MCP server the run's
 * baseline lacked — must be approved by the user before the harness restarts
 * claude with the new role's tools.
 *
 * This module turns an escalation into an ordinary pending approval (the same
 * store the risk gate uses, so the existing Approve/Deny endpoint resolves it)
 * and emits the standard approval.required / approval.resolved / timeout
 * telemetry. Both the runtime manager and the team harness use it, so the
 * policy and its presentation can never drift apart.
 */

import type { ApprovalStore, PendingApproval } from "./approvals";
import { getApprovalStore } from "./approvals";
import type { TelemetryEvent } from "./types";
import {
  capabilityDeltaLabels,
  roleCapabilityDelta,
  type RoleCapabilityDelta,
  type RoleDefinition,
} from "../roles";

export interface RoleEscalationInput {
  runId: string;
  userId: string;
  /** The role the agent is switching from (shown to the user). */
  from: RoleDefinition;
  /** The role the agent wants to switch to. */
  to: RoleDefinition;
  /** The role the run started under — the capability baseline for the policy. */
  baseline: RoleDefinition;
}

const MAX_ACTION_LEN = 400;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The human summary shown on the approval card: "Researcher → Deployer: +Shell, Write". */
export function roleEscalationAction(from: RoleDefinition, to: RoleDefinition, delta: RoleCapabilityDelta): string {
  const added = capabilityDeltaLabels(delta);
  return truncate(`${from.name} → ${to.name}${added.length ? `: adds ${added.join(", ")}` : ""}`, MAX_ACTION_LEN);
}

/** Create the pending role_escalation approval (does not wait for a verdict). */
export function createRoleEscalationApproval(
  input: RoleEscalationInput,
  store: ApprovalStore = getApprovalStore(),
): PendingApproval {
  const delta = roleCapabilityDelta(input.baseline, input.to);
  return store.create({
    runId: input.runId,
    userId: input.userId,
    toolName: "set_role",
    action: roleEscalationAction(input.from, input.to, delta),
    reason:
      "This role switch adds access the run did not start with. Approve only if you want the agent to have it.",
    kind: "role_escalation",
    fromRole: { id: input.from.id, name: input.from.name },
    toRole: { id: input.to.id, name: input.to.name },
    addedPermissions: delta.addedPermissions,
    addedTools: delta.addedTools,
    addedMcpServers: delta.addedMcpServers,
  });
}

/** The approval.required telemetry event for a role escalation. */
export function roleEscalationRequiredEvent(
  approval: PendingApproval,
): Extract<TelemetryEvent, { type: "approval.required" }> {
  return {
    type: "approval.required",
    approval: {
      id: approval.id,
      tool: approval.toolName,
      action: approval.action,
      reason: approval.reason,
      riskLevel: "ask",
      expiresAt: approval.expiresAt,
      kind: "role_escalation",
      ...(approval.fromRole ? { fromRole: approval.fromRole } : {}),
      ...(approval.toRole ? { toRole: approval.toRole } : {}),
      ...(approval.addedPermissions ? { addedPermissions: approval.addedPermissions } : {}),
      ...(approval.addedTools ? { addedTools: approval.addedTools } : {}),
      ...(approval.addedMcpServers ? { addedMcpServers: approval.addedMcpServers } : {}),
    },
  };
}

/**
 * Wait for the user's verdict on a role escalation, forwarding the same
 * lifecycle telemetry the risk gate emits. Cancelling the run resolves the
 * wait as "expired" (never a timeout, so no misleading timeout event).
 */
export async function awaitRoleEscalation(
  approval: PendingApproval,
  opts: {
    publish: (event: TelemetryEvent) => void;
    /** Aborting (cancel/stop) releases the wait like a denied escalation. */
    signal?: AbortSignal;
    store?: ApprovalStore;
  },
): Promise<"approved" | "denied" | "expired"> {
  const store = opts.store ?? getApprovalStore();
  opts.publish(roleEscalationRequiredEvent(approval));

  const verdictPromise = store.waitFor(approval.id);
  let verdict: "approved" | "denied" | "expired";
  if (!opts.signal) {
    verdict = await verdictPromise;
  } else {
    verdict = await Promise.race([
      verdictPromise,
      new Promise<"expired">((resolve) => {
        if (opts.signal!.aborted) return resolve("expired");
        opts.signal!.addEventListener("abort", () => resolve("expired"), { once: true });
      }),
    ]);
  }

  if (verdict === "expired" && !opts.signal?.aborted && store.get(approval.id)?.timedOut === true) {
    opts.publish({
      type: "approval.timeout",
      id: approval.id,
      tool: approval.toolName,
      action: approval.action,
      reason: approval.reason,
      expiresAt: approval.expiresAt,
    });
  }
  opts.publish({ type: "approval.resolved", id: approval.id, verdict });
  return verdict;
}
