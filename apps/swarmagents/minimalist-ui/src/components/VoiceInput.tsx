"use client";

/**
 * VoiceInput — push-to-talk dictation for the Composer.
 *
 * Uses the Web Speech API (`SpeechRecognition`, with the `webkit` prefix
 * Chrome/Edge still ship under) so the user can dictate a task instead of
 * typing it. The interim transcript streams into the draft live; final
 * results accumulate and are committed when dictation stops. Browsers
 * without the API get no mic button at all — the Composer says so in the
 * footer instead of crashing or logging anything.
 *
 * The recognition session is a small class (`DictationSession`) kept
 * separate from the component so the transcript/error state machine is
 * testable without a DOM or a microphone.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { cn } from "../utils/cn";
import { IconButton } from "./ui";

// ---- Web Speech API (minimal structural types; TS ships no SpeechRecognition) ----

export interface SpeechRecognitionResultItem {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionResultItem;
}

export interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** The constructor when the browser has one, else null. SSR-safe. */
export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof Ctor === "function" ? (Ctor as SpeechRecognitionConstructor) : null;
}

/** True when this browser can dictate. */
export function isVoiceInputSupported(): boolean {
  return getSpeechRecognitionConstructor() !== null;
}

// ---- Pure helpers ----

/** "0:07", "1:05" — the elapsed readout while recording. */
export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Compose the draft from what was typed before dictation started, the
 * finalized dictated text, and the in-progress interim tail. Recomputed
 * from scratch on every result event, so a stale interim never lingers.
 */
export function joinDictation(base: string, finalText: string, interimText: string): string {
  return [base, finalText, interimText]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * What the user sees for a recognition error, or null when the error is
 * routine (nothing heard, user stopped it) and should pass silently.
 */
export function recognitionErrorMessage(error: string): string | null {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked — allow microphone access in your browser to dictate.";
    case "audio-capture":
      return "No microphone was found — check your microphone and try again.";
    case "network":
      return "Voice input lost its connection — try again.";
    case "language-not-supported":
      return "Voice input doesn't support this language yet.";
    case "aborted":
    case "no-speech":
      return null;
    default:
      return "Voice input stopped unexpectedly — try again.";
  }
}

// ---- Recognition session (testable without a DOM) ----

export interface DictationCallbacks {
  /** Final dictated text so far, plus the in-progress interim tail. */
  onTranscript: (finalText: string, interimText: string) => void;
  /** The recognizer ended (stopped, errored, or timed out). */
  onEnd: () => void;
  /** A user-facing message, or null when the error passes silently. */
  onError: (message: string | null) => void;
}

/**
 * Wraps one SpeechRecognition instance: continuous dictation with interim
 * results, final segments accumulated in order. Never logs — errors go to
 * the caller as messages, and `stop()`/`dispose()` never throw.
 */
export class DictationSession {
  private readonly recognition: SpeechRecognitionLike;
  private readonly callbacks: DictationCallbacks;
  private finalText = "";
  private started = false;
  private disposed = false;

  constructor(recognition: SpeechRecognitionLike, callbacks: DictationCallbacks) {
    this.recognition = recognition;
    this.callbacks = callbacks;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang =
      typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => {
      if (!this.disposed) this.callbacks.onError(recognitionErrorMessage(event.error));
    };
    recognition.onend = () => {
      this.started = false;
      if (!this.disposed) this.callbacks.onEnd();
    };
  }

  /** Returns false when the recognizer refused to start. */
  start(): boolean {
    try {
      this.recognition.start();
    } catch {
      this.callbacks.onError("Voice input could not start — try again.");
      return false;
    }
    this.started = true;
    return true;
  }

  /** Asks the recognizer to stop; `onEnd` follows with the final text. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.recognition.stop();
    } catch {
      // Already stopped; onend still fires (or already fired).
    }
  }

  /** Tear down without callbacks (unmount). Never throws. */
  dispose(): void {
    this.disposed = true;
    this.recognition.onresult = null;
    this.recognition.onerror = null;
    this.recognition.onend = null;
    try {
      this.recognition.abort();
    } catch {
      // Already stopped.
    }
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    if (this.disposed) return;
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) this.finalText += text;
      else interim += text;
    }
    this.callbacks.onTranscript(this.finalText, interim);
  }
}

// ---- Presentational mic button (each state renderable on its own) ----

export function VoiceInputButton({
  recording,
  elapsedSeconds,
  disabled,
  onToggle,
}: {
  recording: boolean;
  elapsedSeconds: number;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {recording && (
        <span
          data-testid="voice-input-timer"
          className="font-mono text-[12px] tabular-nums text-red-400"
          aria-label={`Recording for ${formatElapsed(elapsedSeconds)}`}
        >
          {formatElapsed(elapsedSeconds)}
        </span>
      )}
      <span className="relative">
        <IconButton
          label={recording ? "Stop voice input" : "Dictate with your voice"}
          data-testid="voice-input-button"
          aria-pressed={recording}
          disabled={disabled}
          onClick={onToggle}
          className={cn(recording && "bg-red-400/10 text-red-400 hover:bg-red-400/15 hover:text-red-300")}
        >
          <Mic className="h-4 w-4" aria-hidden />
        </IconButton>
        {recording && (
          <span
            aria-hidden
            className="sa-dot-live pointer-events-none absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-400"
          />
        )}
      </span>
    </span>
  );
}

// ---- Stateful wrapper ----

export interface VoiceInputProps {
  /** Current composer text; dictation appends to it. */
  value: string;
  onChange: (value: string) => void;
  /** Increment to stop dictation from outside (e.g. when the message sends). */
  stopSignal?: number;
  disabled?: boolean;
  /** Test/embedder override for feature detection; defaults to live detection. */
  supported?: boolean;
  /** Receives runtime notices (mic blocked, no mic, …) or null to clear. */
  onNotice?: (notice: string | null) => void;
}

/**
 * The mic button for the Composer. Renders nothing where the API is
 * missing — the Composer explains that in its footer instead.
 */
export function VoiceInput({
  value,
  onChange,
  stopSignal = 0,
  disabled = false,
  supported,
  onNotice,
}: VoiceInputProps) {
  const isSupported = supported ?? isVoiceInputSupported();
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const sessionRef = useRef<DictationSession | null>(null);
  /** Draft text as it was when dictation started (or last edited by hand). */
  const baseRef = useRef("");
  /** Final dictated text accumulated by the current session. */
  const finalRef = useRef("");
  /** Last draft this component pushed, so hand-typing is told apart from it. */
  const lastPushedRef = useRef("");
  const valueRef = useRef(value);
  valueRef.current = value;

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) return;
    onNotice?.(null);
    const session = new DictationSession(new Ctor(), {
      onTranscript: (finalText, interimText) => {
        finalRef.current = finalText;
        const next = joinDictation(baseRef.current, finalText, interimText);
        lastPushedRef.current = next;
        onChange(next);
      },
      onEnd: () => {
        // Commit the finals and drop any interim tail, then go idle.
        const next = joinDictation(baseRef.current, finalRef.current, "");
        lastPushedRef.current = next;
        onChange(next);
        setRecording(false);
        setElapsedSeconds(0);
      },
      onError: (message) => {
        if (message) onNotice?.(message);
      },
    });
    baseRef.current = valueRef.current;
    finalRef.current = "";
    sessionRef.current = session;
    if (!session.start()) {
      sessionRef.current = null;
      return;
    }
    setRecording(true);
    setElapsedSeconds(0);
  }, [onChange, onNotice]);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  // Elapsed seconds tick while recording.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // A draft change that did not come from dictation — the user typed, or
  // the box was cleared — becomes the new dictation base.
  useEffect(() => {
    if (!recording) return;
    if (value !== lastPushedRef.current) {
      baseRef.current = value;
      finalRef.current = "";
    }
  }, [value, recording]);

  // The Composer stops dictation when the message sends.
  useEffect(() => {
    if (stopSignal === 0) return;
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, [stopSignal]);

  // Never leave a recognizer running past unmount.
  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    },
    [],
  );

  if (!isSupported) return null;

  return (
    <VoiceInputButton
      recording={recording}
      elapsedSeconds={elapsedSeconds}
      disabled={disabled}
      onToggle={() => (recording ? stop() : start())}
    />
  );
}

export default VoiceInput;
