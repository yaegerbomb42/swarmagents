export type ControlState =
  | "AGENT_DRIVING"
  | "HUMAN_REQUESTED"
  | "HUMAN_DRIVING"
  | "HANDBACK";

export interface HandbackSummary {
  text: string;
  tokenCount: number;
  windowTitles: string[];
  modifiedFiles: string[];
  lastFrameCaption: string;
  durationMs: number;
  inputEventsCount: number;
  generatedAt: number;
}

export type InputEvent =
  | {
      kind: "mouse_move";
      x: number;
      y: number;
    }
  | {
      kind: "mouse_down" | "mouse_up";
      x: number;
      y: number;
      button: "left" | "middle" | "right";
    }
  | {
      kind: "mouse_wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: "key_down" | "key_up";
      key: string;
      code: string;
      modifiers: {
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
        meta: boolean;
      };
    }
  | {
      kind: "clipboard_set";
      text: string;
    };

export interface KeyframeMeta {
  id: string;
  timestamp: number;
  width: number;
  height: number;
  activity: string;
  sizeBytes: number;
}

/** Minimal frame shape the captioner needs (subset of the daemon's CapturedFrame). */
export interface CaptionFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}
