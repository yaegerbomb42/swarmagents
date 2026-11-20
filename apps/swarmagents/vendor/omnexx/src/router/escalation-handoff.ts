/**
 * Context-Preserving Escalation Handoff (Step 4.5).
 *
 * When the CascadeCircuitBreaker escalates a task to Tier 3 (Frontier Reasoning),
 * this module compresses intermediate lower-tier tool churn using the Edge Summary
 * pattern and injects a high-priority steering intervention.
 *
 * Crucial Invariant (Step 3.4):
 * Every `tool_use` block must retain a matching `tool_result` block. Rather than
 * deleting messages and corrupting provider API schemas, we compress verbose
 * raw tool dumps in-place and append a structured `<system_intervention type="tier_escalation">`
 * directing the frontier model to diagnose root causes across the system.
 */

import type { ContentBlock, Message } from '../providers/types.js';
import type { EscalationDecision } from './circuit-breaker.js';

export interface EscalationHandoffOptions {
  /** Maximum character length of a single compressed tool result (default: 400). */
  maxCompressedToolChars?: number;
  /** Keep the last N messages uncompressed for immediate context (default: 2). */
  keepRecentMessages?: number;
}

export interface EscalationSummaryItem {
  turnIndex?: number;
  toolName: string;
  isError: boolean;
  brief: string;
}

/**
 * Extract a concise one-line brief from tool result content.
 */
function summarizeToolResult(content: string, isError: boolean): string {
  const clean = content.trim().replace(/\r\n/g, '\n');
  const firstLine = clean.split('\n')[0] ?? '';

  // Extract explicit error code or syntax message if present
  const diagRegex = /\b(?:TS\d{4,5}|E\d{4}|SyntaxError|ParseError|TypeError):?[^\n]*/i;
  const diagMatch = diagRegex.exec(clean);
  if (diagMatch) {
    return diagMatch[0].slice(0, 160);
  }

  if (isError) {
    return firstLine.slice(0, 160) || 'Tool execution returned error';
  }

  return firstLine.slice(0, 120) || 'Success';
}

/**
 * Builds an edge-summarized conversation for Tier 3 escalation while preserving
 * provider API block-pairing invariants.
 */
export function buildEscalationHandoff(
  messages: readonly Message[],
  decision: EscalationDecision,
  options: EscalationHandoffOptions = {},
): Message[] {
  const maxCompressedToolChars = options.maxCompressedToolChars ?? 400;
  const keepRecentMessages = options.keepRecentMessages ?? 2;

  const resultMessages: Message[] = [];
  const summaryItems: EscalationSummaryItem[] = [];

  // Map tool_use IDs to tool names
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolNameMap.set(block.id, block.name);
      }
    }
  }

  const compressionBoundary = Math.max(0, messages.length - keepRecentMessages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    // Hot recent window: preserve as-is
    if (i >= compressionBoundary) {
      resultMessages.push({
        role: msg.role,
        content: [...msg.content],
      });
      continue;
    }

    // Outside hot window: compress tool results to edge summaries
    const newContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const toolName = toolNameMap.get(block.toolUseId) ?? 'tool';
        const isError = Boolean(block.isError);
        const brief = summarizeToolResult(block.content, isError);

        summaryItems.push({
          turnIndex: i,
          toolName,
          isError,
          brief,
        });

        // Compress large dumps
        if (block.content.length > maxCompressedToolChars) {
          const compressedText = isError
            ? `[escalation summary: ${toolName} failed] ${brief}`
            : `[escalation summary: ${toolName} output (${String(block.content.length)} chars compressed)] ${brief}`;

          newContent.push({
            type: 'tool_result',
            toolUseId: block.toolUseId,
            content: compressedText,
            ...(block.isError ? { isError: true } : {}),
          });
        } else {
          newContent.push({ ...block });
        }
      } else {
        newContent.push(block);
      }
    }

    resultMessages.push({
      role: msg.role,
      content: newContent,
    });
  }

  // Format the steering intervention
  const reasonText = decision.reason ?? 'Cascading escalation triggered';
  const summaryBullets =
    summaryItems.length > 0
      ? summaryItems.map((item) => `- ${item.toolName}: ${item.brief}`).join('\n')
      : '- Multiple lower-tier attempts failed to resolve the task.';

  const steeringText = [
    '<system_intervention type="tier_escalation">',
    `ESCALATION: Lower-tier model encountered [${reasonText}]. Elevating to frontier reasoning to resolve root cause.`,
    'Summary of prior attempts:',
    summaryBullets,
    'Instructions for Tier 3 reasoning:',
    '1. Do not repeat failed shallow edits or retry the identical operations above.',
    '2. Perform root-cause architecture analysis across all importing and dependent modules.',
    '3. Formulate a verified patch that satisfies all compiler, static type, and test gate requirements.',
    '</system_intervention>',
  ].join('\n');

  // Append steering note as a user message
  resultMessages.push({
    role: 'user',
    content: [{ type: 'text', text: steeringText }],
  });

  return resultMessages;
}
