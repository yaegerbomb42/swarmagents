"use client";

import { useState } from "react";
import "./browser-view.css";

// A browser-window rendering of one `browser` tool call: address bar, what the agent did, the
// screenshot (with the set-of-marks numbers lib/tools/browser.ts draws), and anything that happened
// along the way (downloads, dialogs, new tabs). The raw element list and page text fold away.

type Img = { mediaType: string; data: string };

export type BrowserSnap = {
  note: string[]; // the action line plus "• …" happenings (downloads, dialogs, tabs)
  tab?: { index: number; count: number };
  title: string;
  url: string;
  elements: string[];
  text: string;
  failed: boolean;
};

// Parses the observation lib/tools/browser.ts returns:
// <note>\n[• happening…]\nTab i/n: <title>\n<url>\n\nInteractive elements:\n…[\n\nPage text:\n…]
export function parseBrowserOutput(out: string): BrowserSnap | null {
  const m = /(^|\n)Tab (\d+)\/(\d+): ([^\n]*)\n([^\n]*)\n/.exec(out);
  if (!m) return null;
  const head = out.slice(0, m.index).split("\n").map((l) => l.trim()).filter(Boolean);
  const rest = out.slice(m.index + m[0].length);
  const pt = rest.indexOf("\n\nPage text:\n");
  const elBlock = (pt >= 0 ? rest.slice(0, pt) : rest).replace(/^\s*Interactive elements:\n?/, "");
  const elements = elBlock.split("\n").filter((l) => l.trim() && l.trim() !== "(none)");
  return {
    note: head,
    tab: { index: Number(m[2]), count: Number(m[3]) },
    title: m[4].trim(),
    url: m[5].trim(),
    elements,
    text: pt >= 0 ? rest.slice(pt + 13) : "",
    failed: /^Action \w+ failed:/.test(head[0] ?? ""),
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// "Clicked [12]", "Typed "hello" into [4]" — what the agent did, in words.
export function describeAction(input: Record<string, unknown>): string {
  const a = str(input.action);
  const tgt =
    input.index != null ? `[${input.index}]` : input.selector ? clip(str(input.selector), 40) : input.text ? `"${clip(str(input.text), 40)}"` : "";
  switch (a) {
    case "goto":
      return `Opened ${clip(hostOf(str(input.url)).host || str(input.url), 60)}`;
    case "click":
      return `Clicked ${tgt}`.trim();
    case "type":
      return `Typed "${clip(str(input.text ?? input.value), 50)}"${input.index != null ? ` into [${input.index}]` : input.selector ? ` into ${clip(str(input.selector), 40)}` : ""}${input.submit ? " and pressed Enter" : ""}`;
    case "press":
      return `Pressed ${str(input.key) || "a key"}`;
    case "scroll":
      return Number(input.dy) < 0 ? "Scrolled up" : "Scrolled down";
    case "select":
      return `Selected "${clip(str(input.value), 40)}" in ${tgt}`;
    case "hover":
      return `Hovered ${tgt}`;
    case "back":
      return "Went back";
    case "forward":
      return "Went forward";
    case "reload":
      return "Reloaded";
    case "read":
      return "Read the page";
    case "eval":
      return "Ran a script on the page";
    case "tab_new":
      return input.url ? `New tab: ${clip(str(input.url), 70)}` : "Opened a new tab";
    case "tab_switch":
      return `Switched to tab ${str(input.tab)}`;
    case "tab_close":
      return "Closed a tab";
    case "wait":
      return `Waited ${((Number(input.ms) || 1500) / 1000).toFixed(1).replace(/\.0$/, "")}s`;
    case "screenshot":
      return "Took a screenshot";
    case "upload":
      return `Uploaded ${clip(str(input.path), 50)}${tgt ? ` to ${tgt}` : ""}`;
    default:
      return a || "Browser";
  }
}

function hostOf(url: string) {
  try {
    const u = new URL(url);
    return { secure: u.protocol === "https:", host: u.host, rest: url.slice(u.origin.length) };
  } catch {
    return { secure: false, host: "", rest: url };
  }
}

const Dots = () => (
  <span className="bv-dots" aria-hidden>
    <i />
    <i />
    <i />
  </span>
);

export function BrowserView({
  input,
  output,
  images,
  status,
  onImage,
}: {
  input: Record<string, unknown>;
  output?: string;
  images?: Img[];
  status: string;
  onImage?: (src: string) => void;
}) {
  const [show, setShow] = useState<"" | "elements" | "text" | "raw">("");
  const live = status === "running" || status === "streaming";
  const snap = output ? parseBrowserOutput(output) : null;
  const shot = images?.[0];
  const src = shot ? `data:${shot.mediaType};base64,${shot.data}` : "";
  const url = snap?.url || (input.action === "goto" ? str(input.url) : "");
  const h = hostOf(url);
  const happenings = (snap?.note ?? []).filter((l) => l.startsWith("•")).map((l) => l.replace(/^•\s*/, "").replace(/ to \/\S*\/(downloads\/[^\s/]+)$/, " to $1"));
  const failLine = snap?.failed ? snap.note[0] : !snap && status === "error" ? (output ?? "").split("\n")[0] : "";

  return (
    <div className={`bv${status === "error" ? " bv-error" : ""}`}>
      <div className="bv-bar">
        <Dots />
        <div className="bv-url" title={url}>
          {url ? (
            <>
              {h.secure ? (
                <svg className="bv-lock" width="10" height="11" viewBox="0 0 10 11" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <rect x="1.5" y="4.8" width="7" height="5.4" rx="1.2" />
                  <path d="M3.2 4.8V3.4a1.8 1.8 0 0 1 3.6 0v1.4" />
                </svg>
              ) : null}
              <span className="bv-host">{h.host || url}</span>
              {h.host && <span className="bv-path">{h.rest === "/" ? "" : h.rest}</span>}
            </>
          ) : (
            <span className="bv-path">{live ? "Starting browser…" : "about:blank"}</span>
          )}
        </div>
        {snap?.tab && snap.tab.count > 1 && (
          <span className="bv-tabs" title={`Tab ${snap.tab.index} of ${snap.tab.count}`}>
            {snap.tab.index}/{snap.tab.count}
          </span>
        )}
      </div>
      <div className="bv-action">
        <span className={`bv-verb${live ? " live" : ""}`}>{describeAction(input)}</span>
        {snap?.title && <span className="bv-title">· {clip(snap.title, 80)}</span>}
      </div>
      {failLine && <div className="bv-fail">{failLine.replace(/^Action \w+ failed:\s*/, "Failed: ")}</div>}
      {!!happenings.length && (
        <ul className="bv-notes">
          {happenings.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <div className="bv-view">
        {src ? (
          <img src={src} alt={snap?.title || "Browser screenshot"} onClick={() => onImage?.(src)} />
        ) : live ? (
          <div className="bv-loading">
            <span className="bv-spin" /> Working…
          </div>
        ) : (
          <div className="bv-empty">No screenshot for this step</div>
        )}
      </div>
      {output && (
        <div className="bv-tabsbar">
          {!!snap?.elements.length && (
            <button className={show === "elements" ? "on" : ""} onClick={() => setShow(show === "elements" ? "" : "elements")}>
              {snap.elements.length} element{snap.elements.length === 1 ? "" : "s"}
            </button>
          )}
          {!!snap?.text && (
            <button className={show === "text" ? "on" : ""} onClick={() => setShow(show === "text" ? "" : "text")}>
              Page text
            </button>
          )}
          <button className={show === "raw" ? "on" : ""} onClick={() => setShow(show === "raw" ? "" : "raw")}>
            Raw output
          </button>
        </div>
      )}
      {show === "elements" && snap && (
        <ol className="bv-els">
          {snap.elements.map((l, i) => {
            const m = /^\[(\d+)\]\s*(.*)$/.exec(l.trim());
            return (
              <li key={i}>
                {m ? (
                  <>
                    <span className="bv-n">{m[1]}</span>
                    <span>{m[2]}</span>
                  </>
                ) : (
                  <span>{l}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {show === "text" && snap && <pre className="bv-pre">{snap.text}</pre>}
      {show === "raw" && <pre className="bv-pre">{output}</pre>}
    </div>
  );
}
