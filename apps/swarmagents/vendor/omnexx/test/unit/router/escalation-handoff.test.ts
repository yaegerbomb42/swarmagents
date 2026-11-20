import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/providers/types.js';
import type { EscalationDecision } from '../../../src/router/circuit-breaker.js';
import { buildEscalationHandoff } from '../../../src/router/escalation-handoff.js';

describe('Step 4.5: Context-Preserving Escalation Handoff', () => {
  it('preserves provider tool_use/tool_result pairing while compressing verbose error outputs', () => {
    const verboseCompilerError =
      'src/auth/token.ts:15:3 - error TS2322: Type "string" is not assignable to type "number".\n' +
      '  const id: number = "abc";\n' +
      '        ~~\n'.repeat(40); // > 400 chars

    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Fix the auth token expiration bug' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_edit_1',
            name: 'edit',
            input: { path: 'src/auth/token.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_edit_1',
            content: verboseCompilerError,
            isError: true,
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Attempting second fix...' }],
      },
    ];

    const decision: EscalationDecision = {
      escalate: true,
      targetTier: 3,
      reason: 'immediate escalation: SYNTAX_ERROR (TS2322)',
    };

    const handoff = buildEscalationHandoff(messages, decision, {
      maxCompressedToolChars: 100,
      keepRecentMessages: 1, // Only the last assistant message is in the hot window
    });

    // Length: 4 original messages + 1 steering intervention = 5 messages
    expect(handoff.length).toBe(5);

    // Verify invariant: tool_use and tool_result IDs remain identical
    const assistantCall = handoff[1]?.content[0];
    const toolResult = handoff[2]?.content[0];
    expect(assistantCall?.type).toBe('tool_use');
    expect(toolResult?.type).toBe('tool_result');
    if (assistantCall?.type === 'tool_use' && toolResult?.type === 'tool_result') {
      expect(assistantCall.id).toBe(toolResult.toolUseId);
      expect(toolResult.content).toContain('[escalation summary: edit failed]');
      expect(toolResult.content).toContain('TS2322');
      expect(toolResult.content.length).toBeLessThan(verboseCompilerError.length);
    }

    // Verify steering intervention at the tail
    const steeringMsg = handoff[handoff.length - 1];
    expect(steeringMsg?.role).toBe('user');
    const textBlock = steeringMsg?.content[0];
    expect(textBlock?.type).toBe('text');
    if (textBlock?.type === 'text') {
      expect(textBlock.text).toContain('<system_intervention type="tier_escalation">');
      expect(textBlock.text).toContain('ESCALATION: Lower-tier model encountered');
      expect(textBlock.text).toContain('TS2322');
      expect(textBlock.text).toContain('- edit:');
      expect(textBlock.text).toContain('Instructions for Tier 3 reasoning:');
    }
  });

  it('preserves recent hot window messages uncompressed', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Task' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_bash_1',
            name: 'bash',
            input: { command: 'test' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_bash_1',
            content: 'x'.repeat(500),
            isError: true,
          },
        ],
      },
    ];

    const decision: EscalationDecision = {
      escalate: true,
      targetTier: 3,
      reason: '2 consecutive failures at tier 2',
    };

    // keepRecentMessages: 2 keeps the last 2 messages (assistant + tool_result) uncompressed
    const handoff = buildEscalationHandoff(messages, decision, {
      maxCompressedToolChars: 100,
      keepRecentMessages: 2,
    });

    const toolResult = handoff[2]?.content[0];
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content.length).toBe(500); // Uncompressed
    }
  });

  it('handles empty tool history gracefully', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];

    const decision: EscalationDecision = {
      escalate: true,
      targetTier: 3,
      reason: 'complex architecture upgrade',
    };

    const handoff = buildEscalationHandoff(messages, decision);
    expect(handoff.length).toBe(2);
    const last = handoff[1]?.content[0];
    expect(last?.type).toBe('text');
    if (last?.type === 'text') {
      expect(last.text).toContain('<system_intervention type="tier_escalation">');
      expect(last.text).toContain('complex architecture upgrade');
    }
  });
});
