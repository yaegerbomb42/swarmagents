import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceBriefing from './VoiceBriefing';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    audioBriefing: vi.fn().mockResolvedValue({
      ok: true,
      briefing: 'SwarmAgents mission briefing. Fleet mode CODER_WORKER.',
      counts: { pending: 1, completed: 2, blocked: 0 },
      active_locks: 0,
      generated_at: 1,
    }),
  },
}));

describe('VoiceBriefing', () => {
  beforeEach(() => {
    class MockUtterance {
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
    }
    vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak: vi.fn((u: MockUtterance) => u.onstart?.()),
        cancel: vi.fn(),
      },
    });
  });

  it('loads and displays briefing text', async () => {
    render(<VoiceBriefing />);
    await waitFor(() => {
      expect(screen.getByText(/SwarmAgents mission briefing/)).toBeInTheDocument();
    });
  });

  it('plays briefing on button click', async () => {
    const user = userEvent.setup();
    render(<VoiceBriefing />);
    await waitFor(() => screen.getByText(/SwarmAgents mission briefing/));
    await user.click(screen.getByLabelText('Play briefing'));
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
  });
});
