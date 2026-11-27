/**
 * VoiceInput tests: feature detection, the pure transcript helpers, the
 * DictationSession state machine (driven by a fake recognizer — no mic, no
 * DOM), and static renders of each button/notice state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import {
  DictationSession,
  VoiceInput,
  VoiceInputButton,
  formatElapsed,
  isVoiceInputSupported,
  joinDictation,
  recognitionErrorMessage,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from "./VoiceInput";

const h = React.createElement;

/** Components are imported after the browser stubs are in place. */
function load() {
  installBrowserStubs();
}

function setSpeechRecognition(ctor: unknown): void {
  (globalThis.window as unknown as Record<string, unknown>).SpeechRecognition = ctor;
  delete (globalThis.window as unknown as Record<string, unknown>).webkitSpeechRecognition;
}

function setWebkitSpeechRecognition(ctor: unknown): void {
  delete (globalThis.window as unknown as Record<string, unknown>).SpeechRecognition;
  (globalThis.window as unknown as Record<string, unknown>).webkitSpeechRecognition = ctor;
}

// ---- Feature detection ----

test("voice input is unsupported when the browser has no SpeechRecognition", () => {
  load();
  assert.equal(isVoiceInputSupported(), false);
});

test("voice input is supported with SpeechRecognition or the webkit prefix", () => {
  load();
  class FakeRecognition {}
  setSpeechRecognition(FakeRecognition);
  assert.equal(isVoiceInputSupported(), true);
  setWebkitSpeechRecognition(FakeRecognition);
  assert.equal(isVoiceInputSupported(), true);
});

// ---- Pure helpers ----

test("formatElapsed renders m:ss", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7), "0:07");
  assert.equal(formatElapsed(65), "1:05");
  assert.equal(formatElapsed(600), "10:00");
});

test("joinDictation composes base, finals, and interim with single spaces", () => {
  assert.equal(joinDictation("hello", "world", ""), "hello world");
  assert.equal(joinDictation("hello", "world", "again"), "hello world again");
  assert.equal(joinDictation("", "dictated", ""), "dictated");
  assert.equal(joinDictation("typed ", " spoken", " in progress "), "typed spoken in progress");
  assert.equal(joinDictation("", "", ""), "");
});

test("recognition errors map to friendly messages or silence", () => {
  assert.match(recognitionErrorMessage("not-allowed") ?? "", /Microphone access is blocked/);
  assert.match(recognitionErrorMessage("audio-capture") ?? "", /No microphone/);
  assert.equal(recognitionErrorMessage("no-speech"), null);
  assert.equal(recognitionErrorMessage("aborted"), null);
  assert.match(recognitionErrorMessage("weird-new-error") ?? "", /stopped unexpectedly/);
});

// ---- DictationSession with a fake recognizer ----

class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  throwOnStart = false;

  start(): void {
    if (this.throwOnStart) throw new Error("already started");
    this.started += 1;
  }

  stop(): void {
    this.stopped += 1;
  }

  abort(): void {
    this.aborted += 1;
  }

  emitResult(results: Array<{ isFinal: boolean; transcript: string }>, resultIndex = 0): void {
    const list = results.map((r) => ({ ...r, length: 1, 0: { transcript: r.transcript } }));
    this.onresult?.({ resultIndex, results: Object.assign(list, { length: list.length }) });
  }

  emitError(error: string): void {
    this.onerror?.({ error });
  }

  emitEnd(): void {
    this.onend?.();
  }
}

function makeSession() {
  const recognition = new FakeRecognition();
  const transcripts: Array<{ finalText: string; interimText: string }> = [];
  const ends: number[] = [];
  const errors: Array<string | null> = [];
  const session = new DictationSession(recognition, {
    onTranscript: (finalText, interimText) => transcripts.push({ finalText, interimText }),
    onEnd: () => ends.push(1),
    onError: (message) => errors.push(message),
  });
  return { recognition, transcripts, ends, errors, session };
}

test("session configures continuous interim dictation and streams live text", () => {
  const { recognition, transcripts, session } = makeSession();
  assert.equal(session.start(), true);
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.started, 1);

  recognition.emitResult([{ isFinal: false, transcript: "hello" }]);
  assert.deepEqual(transcripts, [{ finalText: "", interimText: "hello" }]);

  recognition.emitResult([{ isFinal: true, transcript: "hello " }], 0);
  assert.deepEqual(transcripts.at(-1), { finalText: "hello ", interimText: "" });

  // A later event carries the full results list; resultIndex skips settled finals.
  recognition.emitResult(
    [
      { isFinal: true, transcript: "hello " },
      { isFinal: false, transcript: "world" },
    ],
    1,
  );
  assert.deepEqual(transcripts.at(-1), { finalText: "hello ", interimText: "world" });
});

test("session accumulates finals across results and ends cleanly on stop", () => {
  const { recognition, transcripts, ends, session } = makeSession();
  session.start();
  recognition.emitResult([{ isFinal: true, transcript: "one " }]);
  recognition.emitResult(
    [
      { isFinal: true, transcript: "one " },
      { isFinal: true, transcript: "two " },
    ],
    1,
  );
  assert.equal(transcripts.at(-1)?.finalText, "one two ");

  session.stop();
  assert.equal(recognition.stopped, 1);
  recognition.emitEnd();
  assert.equal(ends.length, 1);
});

test("session reports mic errors as messages and never throws", () => {
  const { recognition, errors, session } = makeSession();
  session.start();
  recognition.emitError("not-allowed");
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /Microphone access is blocked/);
  recognition.emitError("no-speech");
  assert.equal(errors.length, 2);
  assert.equal(errors[1], null);
});

test("session start failure reports once and returns false", () => {
  const { recognition, errors, session } = makeSession();
  recognition.throwOnStart = true;
  assert.equal(session.start(), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /could not start/);
});

test("dispose silences callbacks and aborts without throwing", () => {
  const { recognition, transcripts, ends, session } = makeSession();
  session.start();
  session.dispose();
  assert.equal(recognition.aborted, 1);
  recognition.emitResult([{ isFinal: true, transcript: "late" }]);
  recognition.emitEnd();
  assert.equal(transcripts.length, 0);
  assert.equal(ends.length, 0);
});

// ---- Static renders ----

test("unsupported browsers render no mic button", () => {
  load();
  const markup = renderToStaticMarkup(
    h(VoiceInput, { value: "", onChange: () => {}, supported: false }),
  );
  assert.equal(markup, "");
});

test("supported browsers render the mic button", () => {
  load();
  const markup = renderToStaticMarkup(
    h(VoiceInput, { value: "", onChange: () => {}, supported: true }),
  );
  assert.ok(markup.includes('data-testid="voice-input-button"'), "mic button renders");
  assert.ok(markup.includes("Dictate with your voice"), "idle label");
  assert.ok(!markup.includes('data-testid="voice-input-timer"'), "no timer while idle");
});

test("recording button shows the elapsed timer and stop label", () => {
  load();
  const markup = renderToStaticMarkup(
    h(VoiceInputButton, { recording: true, elapsedSeconds: 7, onToggle: () => {} }),
  );
  assert.ok(markup.includes('data-testid="voice-input-timer"'), "timer renders");
  assert.ok(markup.includes("0:07"), "timer shows elapsed seconds");
  assert.ok(markup.includes("Stop voice input"), "recording label");
  assert.ok(markup.includes('aria-pressed="true"'), "pressed state");
});

test("idle button shows no timer and is not pressed", () => {
  load();
  const markup = renderToStaticMarkup(
    h(VoiceInputButton, { recording: false, elapsedSeconds: 0, onToggle: () => {} }),
  );
  assert.ok(!markup.includes('data-testid="voice-input-timer"'), "no timer while idle");
  assert.ok(markup.includes('aria-pressed="false"'), "unpressed state");
});
