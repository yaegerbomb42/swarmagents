/**
 * Autopilot runs only in the gap the VM driver already owns: after the last
 * prompt and before SWARM_VM_IDLE_MIN (default 30) hibernates the container.
 * IdleSweeper invokes this on the same cadence as sweepIdle (default 60s,
 * never longer than the idle window — see resolveIdlePolicy).
 */
export function inAutopilotWindow(input: {
  enabled: boolean;
  idleMs: number;
  idleForMs: number;
  activeExec: boolean;
}): { ok: boolean; reason: string } {
  if (!input.enabled) return { ok: false, reason: "autopilot off" };
  if (!(input.idleMs > 0)) return { ok: false, reason: "hibernate disabled" };
  if (input.activeExec) return { ok: false, reason: "exec in flight" };
  if (!(input.idleForMs > 0)) return { ok: false, reason: "user is active" };
  if (input.idleForMs >= input.idleMs) return { ok: false, reason: "past hibernate threshold" };
  return { ok: true, reason: "pre-hibernate idle window" };
}
