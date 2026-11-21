import type { ControlState, HandbackSummary } from "./types";

export interface TransitionEvent {
  from: ControlState;
  to: ControlState;
  controllerId: string | null;
  reason?: string;
  timestamp: number;
}

export type TransitionListener = (event: TransitionEvent) => void;

const ALLOWED_TRANSITIONS: Record<ControlState, readonly ControlState[]> = {
  AGENT_DRIVING: ["HUMAN_REQUESTED"],
  HUMAN_REQUESTED: ["HUMAN_DRIVING", "AGENT_DRIVING"],
  HUMAN_DRIVING: ["HANDBACK"],
  HANDBACK: ["AGENT_DRIVING"],
};

export class StateTransitionError extends Error {
  readonly code: string;
  readonly from: ControlState;
  readonly to: ControlState;

  constructor(code: string, from: ControlState, to: ControlState, message: string) {
    super(message);
    this.name = "StateTransitionError";
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

export class TakeoverStateMachine {
  private _state: ControlState = "AGENT_DRIVING";
  private _controllerId: string | null = null;
  private _lastSummary: HandbackSummary | null = null;
  private readonly listeners = new Set<TransitionListener>();

  get state(): ControlState {
    return this._state;
  }

  get controllerId(): string | null {
    return this._controllerId;
  }

  get lastSummary(): HandbackSummary | null {
    return this._lastSummary;
  }

  onTransition(listener: TransitionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  canAcceptInput(clientId: string): boolean {
    return this._state === "HUMAN_DRIVING" && this._controllerId === clientId;
  }

  requestTakeover(clientId: string): TransitionEvent {
    if (this._state === "HUMAN_REQUESTED" || this._state === "HUMAN_DRIVING") {
      throw new StateTransitionError(
        "TAKEOVER_ALREADY_ACTIVE",
        this._state,
        "HUMAN_REQUESTED",
        `Takeover already active (state=${this._state}, controller=${this._controllerId ?? "none"})`,
      );
    }
    this.assertTransition("HUMAN_REQUESTED");
    this._controllerId = clientId;
    return this.commit("HUMAN_REQUESTED", "human_requested");
  }

  grantHumanControl(): TransitionEvent {
    this.assertTransition("HUMAN_DRIVING");
    if (!this._controllerId) {
      throw new StateTransitionError(
        "NO_CONTROLLER",
        this._state,
        "HUMAN_DRIVING",
        "Cannot enter HUMAN_DRIVING without an assigned controller",
      );
    }
    return this.commit("HUMAN_DRIVING", "agent_reached_safe_point");
  }

  cancelTakeoverRequest(reason = "controller_disconnected"): TransitionEvent {
    if (this._state !== "HUMAN_REQUESTED") {
      throw new StateTransitionError(
        "INVALID_TRANSITION",
        this._state,
        "AGENT_DRIVING",
        `Cannot cancel takeover from state ${this._state}`,
      );
    }
    this._controllerId = null;
    return this.commit("AGENT_DRIVING", reason);
  }

  beginHandback(clientId: string, force = false): TransitionEvent {
    this.assertTransition("HANDBACK");
    if (!force && this._controllerId !== clientId) {
      throw new StateTransitionError(
        "NOT_ACTIVE_CONTROLLER",
        this._state,
        "HANDBACK",
        `Client ${clientId} is not the active controller`,
      );
    }
    return this.commit("HANDBACK", force ? "forced_handback" : "human_handback");
  }

  completeHandback(summary: HandbackSummary): TransitionEvent {
    this.assertTransition("AGENT_DRIVING");
    this._lastSummary = summary;
    this._controllerId = null;
    return this.commit("AGENT_DRIVING", "handback_complete");
  }

  handleControllerDisconnect(clientId: string): "cancelled" | "handback_started" | "noop" {
    if (this._controllerId !== clientId) {
      return "noop";
    }
    if (this._state === "HUMAN_REQUESTED") {
      this.cancelTakeoverRequest("controller_disconnected");
      return "cancelled";
    }
    if (this._state === "HUMAN_DRIVING") {
      this.beginHandback(clientId, true);
      return "handback_started";
    }
    return "noop";
  }

  private assertTransition(target: ControlState): void {
    const allowed = ALLOWED_TRANSITIONS[this._state];
    if (!allowed.includes(target)) {
      throw new StateTransitionError(
        "INVALID_TRANSITION",
        this._state,
        target,
        `Transition ${this._state} -> ${target} is not allowed`,
      );
    }
  }

  private commit(next: ControlState, reason?: string): TransitionEvent {
    const event: TransitionEvent = {
      from: this._state,
      to: next,
      controllerId: this._controllerId,
      reason,
      timestamp: Date.now(),
    };
    this._state = next;
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }
}
