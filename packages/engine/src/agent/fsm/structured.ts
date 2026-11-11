/**
 * Step 6.3: Universal structuredCall Contract.
 *
 * Enforces structured output extraction from LLMs with:
 *   - Forced single 'answer' tool call matching z.toJSONSchema(spec.schema)
 *   - Ground-truth validation (e.g. files exist, line spans valid)
 *   - Max 2 repair turns injecting validator diagnostics
 *   - 1 model escalation step if cheap model fails
 *   - Typed SCHEMA_EXHAUSTED error when bounds are exceeded
 */

import { z } from 'zod';

export interface StructuredSpec<T> {
  name: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  role?: string;
  validator?: (
    data: T,
  ) => Promise<{ valid: boolean; error?: string }> | { valid: boolean; error?: string };
}

export type StructuredResult<T> =
  | { success: true; data: T; turns: number; escalated: boolean }
  | {
      success: false;
      error: 'SCHEMA_EXHAUSTED';
      reason: string;
      turns: number;
      escalated: boolean;
    };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; content?: string };

export interface StructuredCaller {
  cheapComplete: (
    req: {
      system: { text: string }[];
      tools: { name: string; description: string; inputSchema: unknown }[];
      toolChoice: { type: 'tool'; name: string };
      messages: { role: 'user' | 'assistant'; content: ContentBlock[] }[];
      maxTokens: number;
    },
    opts?: {
      escalate?: boolean;
      role?: string;
    },
  ) => Promise<{
    content: (
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    )[];
  } | null>;
}

export const MAX_REPAIR_TURNS = 2;

/**
 * Universal structured LLM call with retry, ground-truth validation, and model escalation.
 */
export async function structuredCall<T>(
  caller: StructuredCaller,
  spec: StructuredSpec<T>,
): Promise<StructuredResult<T>> {
  const jsonSchema = z.toJSONSchema(spec.schema);
  const maxTokens = spec.maxTokens ?? 2048;

  const messages: {
    role: 'user' | 'assistant';
    content: ContentBlock[];
  }[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: spec.prompt }],
    },
  ];

  let turns = 0;
  let escalated = false;
  let lastFailureReason = 'Unknown failure';

  // Total attempts: Initial + 2 repairs on cheap model + 1 escalation attempt = 4 attempts max
  const maxAttempts = 1 + MAX_REPAIR_TURNS + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    turns += 1;
    const shouldEscalate = attempt > MAX_REPAIR_TURNS;
    if (shouldEscalate) escalated = true;

    let res: {
      content: (
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
      )[];
    } | null;

    try {
      res = await caller.cheapComplete(
        {
          system: [{ text: spec.system }],
          tools: [
            {
              name: 'answer',
              description: `Submit output matching ${spec.name}`,
              inputSchema: jsonSchema,
            },
          ],
          toolChoice: { type: 'tool', name: 'answer' },
          messages,
          maxTokens,
        },
        {
          escalate: shouldEscalate,
          ...(spec.role ? { role: spec.role } : {}),
        },
      );
    } catch (err) {
      lastFailureReason = `Model invocation failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (!res) {
      lastFailureReason = 'Empty response from model';
      continue;
    }

    const toolUse = res.content.find((b) => b.type === 'tool_use' && b.name === 'answer');
    if (toolUse?.type !== 'tool_use') {
      lastFailureReason = "Model did not invoke the required 'answer' tool";
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Error: You must invoke the 'answer' tool with the structured JSON matching the requested schema. Please try again.`,
          },
        ],
      });
      continue;
    }

    // Validate Zod schema
    const parseResult = spec.schema.safeParse(toolUse.input);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(', ');
      lastFailureReason = `Schema validation failed: ${issues}`;

      messages.push({
        role: 'assistant',
        content: [toolUse],
      });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Validation Error: The submitted 'answer' parameters failed schema validation:\n${issues}\nPlease submit a corrected 'answer'.`,
          },
        ],
      });
      continue;
    }

    // Run ground-truth validator if provided
    if (spec.validator) {
      const valResult = await spec.validator(parseResult.data);
      if (!valResult.valid) {
        lastFailureReason = valResult.error ?? 'Ground-truth validation failed';

        messages.push({
          role: 'assistant',
          content: [toolUse],
        });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Semantic Ground-Truth Error: ${lastFailureReason}\nPlease submit a corrected 'answer'.`,
            },
          ],
        });
        continue;
      }
    }

    // Success!
    return {
      success: true,
      data: parseResult.data,
      turns,
      escalated,
    };
  }

  return {
    success: false,
    error: 'SCHEMA_EXHAUSTED',
    reason: lastFailureReason,
    turns,
    escalated,
  };
}
