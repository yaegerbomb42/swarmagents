/**
 * Decoupled Mid-Turn Interrupt Bus (TurnInterruptBus)
 *
 * Allows external controllers, user steering interventions, and watchdog monitors
 * to interrupt an in-flight tool wave or model generation without dropping conversational
 * invariants or crashing the agent session.
 */

export type InterruptReason = 'steer' | 'cancel' | 'resource';

export interface InterruptEvent {
  reason: InterruptReason;
  payload?: string | undefined;
  timestamp: number;
}

export class TurnInterruptBus {
  private abortController: AbortController = new AbortController();
  private currentInterrupt: InterruptEvent | null = null;
  private readonly listeners = new Set<(event: InterruptEvent) => void>();

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get isInterrupted(): boolean {
    return this.abortController.signal.aborted;
  }

  get reason(): InterruptReason | null {
    return this.currentInterrupt?.reason ?? null;
  }

  get payload(): string | null {
    return this.currentInterrupt?.payload ?? null;
  }

  /**
   * Arm or trigger an interruption on the active turn.
   */
  trigger(reason: InterruptReason, payload?: string): void {
    if (this.currentInterrupt) return; // already latched

    const event: InterruptEvent = {
      reason,
      payload,
      timestamp: Date.now(),
    };

    this.currentInterrupt = event;
    this.abortController.abort(
      new Error(`Interrupted: ${reason}${payload ? ` - ${payload}` : ''}`),
    );

    // Snapshot: a listener may unsubscribe (or register another listener) while we dispatch.
    // Iterating the live Set used to skip listeners in that case.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Safe dispatch: listeners must not crash the bus
      }
    }
  }

  /**
   * Listen for interrupt events. A listener registered after the turn was already interrupted
   * is called immediately with the latched event, so a late subscriber cannot miss a stop.
   */
  onInterrupt(callback: (event: InterruptEvent) => void): () => void {
    if (this.currentInterrupt) {
      try {
        callback(this.currentInterrupt);
      } catch {
        // Safe dispatch: a listener must not crash the bus.
      }
      return () => undefined;
    }
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Reset the interrupt bus for the subsequent turn (re-arming the abort signal).
   * Listeners stay registered; they are bus-scoped, not turn-scoped.
   */
  reset(): void {
    this.abortController = new AbortController();
    this.currentInterrupt = null;
  }

  /** Drop every listener and release the signal (session shutdown). */
  dispose(): void {
    this.listeners.clear();
    this.currentInterrupt = null;
    this.abortController = new AbortController();
  }
}
