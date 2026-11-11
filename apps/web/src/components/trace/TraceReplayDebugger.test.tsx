import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TraceReplayDebugger, { DEFAULT_TRACE_STEPS } from './TraceReplayDebugger';

describe('TraceReplayDebugger', () => {
  it('renders an honest empty state when no steps are provided', () => {
    render(<TraceReplayDebugger />);
    expect(screen.getByTestId('trace-empty-state')).toBeDefined();
    expect(screen.queryByTestId('trace-scrubber-slider')).toBeNull();
  });

  it('renders trace replay debugger with default trajectory steps', () => {
    render(<TraceReplayDebugger initialSteps={DEFAULT_TRACE_STEPS} currentAgentLabel="Lead Orchestrator" />);
    expect(screen.getByTestId('trace-replay-debugger')).toBeDefined();
    expect(screen.getByText(/Time-Travel Trace Replay/i)).toBeDefined();
    expect(screen.getByText('Lead Orchestrator')).toBeDefined();
    expect(screen.getByText(/Step 5 of 5/i)).toBeDefined();
  });

  it('allows seeking steps via range input', () => {
    render(<TraceReplayDebugger initialSteps={DEFAULT_TRACE_STEPS} currentAgentLabel="Lead Orchestrator" />);
    const slider = screen.getByTestId('trace-scrubber-slider') as HTMLInputElement;
    expect(slider.value).toBe('4');

    fireEvent.change(slider, { target: { value: '1' } });
    expect(screen.getByText(/Step 2 of 5/i)).toBeDefined();
    expect(screen.getByText(/hamiltonian_decide/i)).toBeDefined();
  });

  it('toggles playback with play/pause button', async () => {
    render(<TraceReplayDebugger initialSteps={DEFAULT_TRACE_STEPS} currentAgentLabel="Lead Orchestrator" />);
    const playBtn = screen.getByTestId('trace-play-btn');
    expect(screen.getByText('Play')).toBeDefined();

    fireEvent.click(playBtn);
    expect(screen.getByText('Pause')).toBeDefined();

    fireEvent.click(playBtn);
    expect(screen.getByText('Play')).toBeDefined();
  });

  it('opens fork modal and triggers onForkRun callback', async () => {
    const handleFork = vi.fn();
    render(<TraceReplayDebugger initialSteps={DEFAULT_TRACE_STEPS} onForkRun={handleFork} />);

    const forkBtn = screen.getByTestId('fork-run-btn');
    fireEvent.click(forkBtn);

    expect(screen.getByTestId('fork-modal')).toBeDefined();
    const promptInput = screen.getByTestId('fork-prompt-input');
    fireEvent.change(promptInput, { target: { value: 'Speculative run on step 5' } });

    const confirmBtn = screen.getByTestId('confirm-fork-btn');
    fireEvent.click(confirmBtn);

    expect(handleFork).toHaveBeenCalledWith(4, expect.objectContaining({
      forkPrompt: 'Speculative run on step 5'
    }));

    await waitFor(() => {
      expect(screen.getByText(/Forked mission trajectory/i)).toBeDefined();
    });
  });
});
