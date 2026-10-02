"use client";

import React, { memo } from "react";

export function hasAnsi(text: string): boolean {
  return /\x1b\[/.test(text);
}

const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

type AnsiStyle = {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fgClass?: string;
  bgClass?: string;
  fgColor?: string;
  bgColor?: string;
};

type SpanNode = {
  text: string;
  style: AnsiStyle;
};

// Standard xterm 256 color palette for mapping
const XTERM_COLORS = [
  // 0-15 are standard colors, handled by classes
  ...Array(16).fill(""),
  // 16-231 are a 6x6x6 color cube
  ...Array.from({ length: 216 }, (_, i) => {
    const r = Math.floor(i / 36) * 51;
    const g = Math.floor((i % 36) / 6) * 51;
    const b = (i % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }),
  // 232-255 are grayscale
  ...Array.from({ length: 24 }, (_, i) => {
    const v = i * 10 + 8;
    return `rgb(${v},${v},${v})`;
  })
];

function parseAnsi(text: string): SpanNode[] {
  const nodes: SpanNode[] = [];
  let currentStyle: AnsiStyle = {};
  
  const regex = /\x1b\[([0-9;]*)([a-zA-Z])/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({
        text: text.slice(lastIndex, match.index),
        style: { ...currentStyle }
      });
    }

    const params = match[1] ? match[1].split(";").map(Number) : [0];
    const command = match[2];

    if (command === "m") {
      let i = 0;
      while (i < params.length) {
        const code = params[i];
        
        if (code === 0) {
          currentStyle = {};
        } else if (code === 1) {
          currentStyle.bold = true;
        } else if (code === 2) {
          currentStyle.dim = true;
        } else if (code === 3) {
          currentStyle.italic = true;
        } else if (code === 4) {
          currentStyle.underline = true;
        } else if (code === 9) {
          currentStyle.strike = true;
        } else if (code >= 30 && code <= 37) {
          currentStyle.fgClass = `ansi-fg-${COLORS[code - 30]}`;
          currentStyle.fgColor = undefined;
        } else if (code === 39) {
          currentStyle.fgClass = undefined;
          currentStyle.fgColor = undefined;
        } else if (code >= 40 && code <= 47) {
          currentStyle.bgClass = `ansi-bg-${COLORS[code - 40]}`;
          currentStyle.bgColor = undefined;
        } else if (code === 49) {
          currentStyle.bgClass = undefined;
          currentStyle.bgColor = undefined;
        } else if (code >= 90 && code <= 97) {
          currentStyle.fgClass = `ansi-fg-bright-${COLORS[code - 90]}`;
          currentStyle.fgColor = undefined;
        } else if (code >= 100 && code <= 107) {
          currentStyle.bgClass = `ansi-bg-bright-${COLORS[code - 100]}`;
          currentStyle.bgColor = undefined;
        } else if (code === 38 || code === 48) {
          const isBg = code === 48;
          const mode = params[i + 1];
          if (mode === 5 && i + 2 < params.length) {
            const colorIndex = params[i + 2];
            i += 2;
            if (colorIndex >= 0 && colorIndex <= 15) {
              const baseColor = COLORS[colorIndex % 8];
              if (isBg) {
                currentStyle.bgClass = colorIndex >= 8 ? `ansi-bg-bright-${baseColor}` : `ansi-bg-${baseColor}`;
                currentStyle.bgColor = undefined;
              } else {
                currentStyle.fgClass = colorIndex >= 8 ? `ansi-fg-bright-${baseColor}` : `ansi-fg-${baseColor}`;
                currentStyle.fgColor = undefined;
              }
            } else if (colorIndex >= 16 && colorIndex <= 255) {
              if (isBg) {
                currentStyle.bgColor = XTERM_COLORS[colorIndex];
                currentStyle.bgClass = undefined;
              } else {
                currentStyle.fgColor = XTERM_COLORS[colorIndex];
                currentStyle.fgClass = undefined;
              }
            }
          } else if (mode === 2 && i + 4 < params.length) {
            const r = params[i + 2];
            const g = params[i + 3];
            const b = params[i + 4];
            i += 4;
            const rgb = `rgb(${r},${g},${b})`;
            if (isBg) {
              currentStyle.bgColor = rgb;
              currentStyle.bgClass = undefined;
            } else {
              currentStyle.fgColor = rgb;
              currentStyle.fgClass = undefined;
            }
          }
        }
        i++;
      }
    }
    // Ignore non-'m' commands (cursor movement, clear screen, etc)
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push({
      text: text.slice(lastIndex),
      style: { ...currentStyle }
    });
  }

  return nodes;
}

function coalesceNodes(nodes: SpanNode[]): SpanNode[] {
  const result: SpanNode[] = [];
  for (const node of nodes) {
    if (!node.text) continue;
    
    if (result.length > 0) {
      const prev = result[result.length - 1];
      if (JSON.stringify(prev.style) === JSON.stringify(node.style)) {
        prev.text += node.text;
        continue;
      }
    }
    result.push({ ...node });
  }
  return result;
}

const AnsiRendererComponent = ({ text }: { text: string }) => {
  if (!text) return null;

  // Enforce 5000 lines limit
  const lines = text.split("\n");
  const MAX_LINES = 5000;
  let truncatedText = text;
  let linesOmitted = 0;
  
  if (lines.length > MAX_LINES) {
    linesOmitted = lines.length - MAX_LINES;
    truncatedText = lines.slice(0, MAX_LINES).join("\n");
  }

  const nodes = parseAnsi(truncatedText);
  const coalesced = coalesceNodes(nodes);

  return (
    <>
      {coalesced.map((node, idx) => {
        const classes = [];
        const inlineStyle: React.CSSProperties = {};

        if (node.style.bold) classes.push("ansi-bold");
        if (node.style.dim) classes.push("ansi-dim");
        if (node.style.italic) classes.push("ansi-italic");
        if (node.style.underline) classes.push("ansi-underline");
        if (node.style.strike) classes.push("ansi-strike");
        
        if (node.style.fgClass) classes.push(node.style.fgClass);
        if (node.style.bgClass) classes.push(node.style.bgClass);
        
        if (node.style.fgColor) inlineStyle.color = node.style.fgColor;
        if (node.style.bgColor) inlineStyle.backgroundColor = node.style.bgColor;

        const className = classes.length > 0 ? classes.join(" ") : undefined;

        if (!className && Object.keys(inlineStyle).length === 0) {
          return <React.Fragment key={idx}>{node.text}</React.Fragment>;
        }

        return (
          <span key={idx} className={className} style={Object.keys(inlineStyle).length > 0 ? inlineStyle : undefined}>
            {node.text}
          </span>
        );
      })}
      {linesOmitted > 0 && (
        <span className="ansi-dim ansi-italic">
          \n... {linesOmitted} more lines truncated
        </span>
      )}
    </>
  );
};

export const AnsiRenderer = memo(AnsiRendererComponent);
