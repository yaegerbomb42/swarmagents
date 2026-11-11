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
  private listeners: ((event: InterruptEvent) => void)[] = [];

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

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Safe dispatch: listeners must not crash the bus
      }
    }
  }

  /**
   * Listen for interrupt events.
   */
  onInterrupt(callback: (event: InterruptEvent) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  /**
   * Reset the interrupt bus for the subsequent turn (re-arming the abort signal).
   */
  reset(): void {
    this.abortController = new AbortController();
    this.currentInterrupt = null;
  }
}
