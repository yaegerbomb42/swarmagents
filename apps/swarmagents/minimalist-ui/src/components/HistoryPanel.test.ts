import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryPanel, filterThreads } from "./HistoryPanel";
import { installBrowserStubs } from "../testing/harness";
import type { ThreadSummary } from "../../../lib/client/thread";

installBrowserStubs();

const mockThreads: ThreadSummary[] = [
  {
    id: "thread-1",
    title: "Implement history search feature and test full conversation titles with hover attribute",
    createdAt: 1000,
    updatedAt: 2000,
    runCount: 3,
  },
  {
    id: "thread-2",
    title: "Fix bug in VM runner timeout handling",
    createdAt: 3000,
    updatedAt: 4000,
    runCount: 1,
  },
  {
    id: "thread-3",
    title: "", // untitled chat
    createdAt: 5000,
    updatedAt: 6000,
    runCount: 2,
  },
];

test("filterThreads filters conversations by title case-insensitively", () => {
  assert.equal(filterThreads(mockThreads, "").length, 3);
  assert.equal(filterThreads(mockThreads, "   ").length, 3);

  const searchSearch = filterThreads(mockThreads, "search");
  assert.equal(searchSearch.length, 1);
  assert.equal(searchSearch[0].id, "thread-1");

  const searchRunner = filterThreads(mockThreads, "RUNNER");
  assert.equal(searchRunner.length, 1);
  assert.equal(searchRunner[0].id, "thread-2");

  const searchUntitled = filterThreads(mockThreads, "untitled");
  assert.equal(searchUntitled.length, 1);
  assert.equal(searchUntitled[0].id, "thread-3");

  const searchNone = filterThreads(mockThreads, "nonexistent");
  assert.equal(searchNone.length, 0);
});

test("HistoryPanel renders search input and full title in title attribute", () => {
  const html = renderToStaticMarkup(
    React.createElement(HistoryPanel, {
      open: true,
      onClose: () => {},
      threads: mockThreads,
      state: "ready",
      currentId: "thread-1",
      activeId: "thread-1",
      onSelect: () => {},
      onNewChat: () => {},
      newChatDisabled: false,
      onRetry: () => {},
    }),
  );

  // Search input is rendered
  assert.match(html, /data-testid="history-search-input"/);
  assert.match(html, /placeholder="Search conversations…"/);

  // Buttons have title attribute showing full title
  assert.match(
    html,
    /title="Implement history search feature and test full conversation titles with hover attribute"/,
  );
  assert.match(html, /title="Fix bug in VM runner timeout handling"/);
  assert.match(html, /title="Untitled chat"/);
});

test("HistoryPanel hides search when empty or loading", () => {
  const emptyHtml = renderToStaticMarkup(
    React.createElement(HistoryPanel, {
      open: true,
      onClose: () => {},
      threads: [],
      state: "ready",
      currentId: "",
      onSelect: () => {},
      onNewChat: () => {},
      newChatDisabled: false,
      onRetry: () => {},
    }),
  );
  assert.doesNotMatch(emptyHtml, /data-testid="history-search-input"/);
  assert.match(emptyHtml, /data-testid="history-empty"/);

  const loadingHtml = renderToStaticMarkup(
    React.createElement(HistoryPanel, {
      open: true,
      onClose: () => {},
      threads: mockThreads,
      state: "loading",
      currentId: "",
      onSelect: () => {},
      onNewChat: () => {},
      newChatDisabled: false,
      onRetry: () => {},
    }),
  );
  assert.doesNotMatch(loadingHtml, /data-testid="history-search-input"/);
});
