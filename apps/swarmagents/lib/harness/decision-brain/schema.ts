import { z } from "zod";
import type { DecisionKind } from "./types";

export const DECISION_VALUES = [
  "continue",
  "retry",
  "ask",
  "verify",
  "stop",
] as const satisfies readonly DecisionKind[];

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export const DecisionPayloadSchema = z.object({
  decision: z.enum(DECISION_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z
    .string()
    .trim()
    .min(1, "reason must be non-empty")
    .refine((val) => countWords(val) <= 12, {
      message: "reason must be at most 12 words",
    }),
});

export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;

export const DecisionResultSchema = DecisionPayloadSchema.extend({
  escalated: z.boolean(),
});

export const DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "confidence", "reason"],
  properties: {
    decision: {
      type: "string",
      enum: [...DECISION_VALUES],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    reason: {
      type: "string",
      description: "Concise justification of at most 12 words.",
    },
  },
} as const;

export function truncateReasonToTwelveWords(reason: string): string {
  const words = reason.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "No reason provided";
  return words.slice(0, 12).join(" ");
}

export function parseDecisionPayload(rawText: string): DecisionPayload {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed: unknown = JSON.parse(cleaned);
  return DecisionPayloadSchema.parse(parsed);
}
