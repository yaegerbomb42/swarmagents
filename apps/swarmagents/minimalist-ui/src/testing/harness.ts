/**
 * Shared scaffolding for the workspace's unit tests.
 *
 * The suite runs on node:test with no DOM, so components are checked with a
 * static render (`renderToStaticMarkup`). Effects never run in a static
 * render, which makes the markup a deterministic picture of each state.
 * The page's module graph pulls in noVNC, which touches browser globals at
 * import time: call `installBrowserStubs()` before importing any component.
 */

import React from "react";
import type { ThreadEntry } from "../../../lib/client/thread";
import type { SwarmTask } from "../../../lib/mcp-types";
import type { AgentSession } from "../hooks/useAgentSession";
import { countTasks, type Board } from "../hooks/useBoard";

export interface BrowserStubOptions {
  /** localStorage contents by key, as plain values (stored JSON-encoded, like the app does). */
  local?: Record<string, unknown>;
  /** What matchMedia reports. True renders the wide (desktop) layout. */
  wide?: boolean;
}

export function installBrowserStubs(options: BrowserStubOptions = {}): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const local = options.local ?? {};

  class StubObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  const localStorage = {
    getItem: (key: string) => (key in local ? JSON.stringify(local[key]) : null),
    setItem: () => {},
    removeItem: () => {},
  };
  const sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const element = () => ({
    style: {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    getContext: () => null,
    getElementsByTagName: () => [],
  });

  g.window = {
    console,
    location: { hash: "" },
    history: { replaceState() {} },
    localStorage,
    sessionStorage,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({
      matches: options.wide ?? false,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
  g.document = {
    documentElement: { style: {}, appendChild() {}, removeChild() {} },
    body: { appendChild() {}, removeChild() {} },
    createElement: element,
    querySelector: () => null,
    getElementsByTagName: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  g.localStorage = localStorage;
  g.sessionStorage = sessionStorage;
  g.MediaStream = class {};
  g.MutationObserver = StubObserver;
  g.ResizeObserver = StubObserver;
  g.requestAnimationFrame = (cb: (time: number) => void) => setTimeout(() => cb(0), 0);
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  // TSX is compiled with the classic transform outside Next.
  g.React = React;
}

/**
 * Take the stubs away again. Server modules refuse to run when `window`
 * exists, so a test that renders and also calls route handlers removes the
 * stubs as soon as it has its markup.
 */
export function uninstallBrowserStubs(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "localStorage", "sessionStorage"]) delete g[key];
}

/** How many times `needle` appears in `html`. */
export function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The opening tag of the element with this test id ("" when it is not rendered). */
export function tagOf(html: string, testId: string): string {
  return new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
}

const noop = () => {};

export function makeEntry(overrides: Partial<ThreadEntry> = {}): ThreadEntry {
  return {
    runId: "run_1",
    prompt: "Build a thing",
    status: "finished",
    kind: "agent",
    createdAt: 1_700_000_000_000,
    tokensReported: false,
    ...overrides,
  };
}

/** A signed-in, loaded session with nothing in it; override what a test needs. */
export function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    ready: true,
    signedOut: false,
    offline: false,
    threads: [],
    threadsState: "ready",
    threadKey: "",
    title: "New chat",
    selectThread: noop,
    newChat: noop,
    turns: [],
    turnsLoading: false,
    pending: undefined,
    promptFor: (entry) => ({ text: entry.prompt, attachments: [] }),
    runById: () => undefined,
    activeRun: undefined,
    activeInView: false,
    headRun: undefined,
    phase: null,
    busy: false,
    activity: undefined,
    liveRunId: undefined,
    liveItems: [],
    liveEntries: [],
    reconnecting: false,
    approvals: [],
    handoffs: [],
    send: async () => ({ ok: false, error: "send is not wired in this test" }),
    steer: async () => ({ ok: false, error: "steer is not wired in this test" }),
    stop: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    answerQuestion: async () => true,
    handBack: async () => true,
    markHandedBack: noop,
    showActiveRun: noop,
    refresh: noop,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: "task_1",
    title: "A task",
    description: "A task",
    difficulty: "medium",
    constraints: [],
    status: "open",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** A loaded board over `tasks`; the actions refuse unless a test supplies them. */
export function makeBoard(tasks: SwarmTask[] = [], overrides: Partial<Board> = {}): Board {
  const refuse = async () => ({ ok: false as const, error: "not wired in this test", retryable: false });
  return {
    status: "ready",
    tasks,
    counts: countTasks(tasks),
    writable: true,
    refresh: async () => {},
    ask: refuse,
    addTask: refuse,
    claim: refuse,
    submit: refuse,
    links: {},
    linkRun: noop,
    ...overrides,
  };
}
