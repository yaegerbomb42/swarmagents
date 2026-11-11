import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgentGroupChat from './AgentGroupChat';

vi.mock('@/hooks/useAgentTelemetry', () => ({
  useAgentTelemetry: vi.fn(({ sessionId, enabled }: { sessionId?: string; enabled?: boolean }) => {
    if (!sessionId || enabled === false) {
      return {
        sandboxes: [],
        connected: false,
        latencyMs: null,
        error: null,
        updateSandbox: vi.fn(),
      };
    }
    return {
      sandboxes: [
      {
        id: 'a1',
        agentId: 'agent-alpha',
        nodeId: 'n1',
        label: 'Alpha',
        model: 'DeepSeek-V4-Flash',
        mode: 'mixed',
        status: 'running',
        tools: [],
        logs: [],
        toolCallCount: 0,
        thoughtStream: [{ text: 'Planning the API layer', ts: 1000, elapsedMs: 120 }],
        actionLog: [
          {
            id: 'act-1',
            ts: 2000,
            type: 'communicate',
            label: 'Handing off to Beta for review',
            status: 'done',
          },
        ],
      },
    ],
    connected: true,
    latencyMs: 42,
    error: null,
    updateSandbox: vi.fn(),
    };
  }),
}));

afterEach(() => vi.clearAllMocks());

describe('AgentGroupChat', () => {
  it('renders thought and communicate messages from telemetry', () => {
    render(<AgentGroupChat sessionId="sess-1" />);
    expect(screen.getByText('Agent Groupchat')).toBeInTheDocument();
    expect(screen.getByText('Planning the API layer')).toBeInTheDocument();
    expect(screen.getByText('Handing off to Beta for review')).toBeInTheDocument();
    expect(screen.getAllByText('DeepSeek-V4-Flash').length).toBeGreaterThan(0);
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('shows empty state without session', () => {
    render(<AgentGroupChat />);
    expect(screen.getByText(/Start a decomp session/)).toBeInTheDocument();
  });
});
