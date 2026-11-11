import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CommandPalette from '@/components/CommandPalette';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('CommandPalette omnibar', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = function () {};
    }
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('opens on Cmd+K and closes on Escape', async () => {
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('lists real routes (no dead actions)', async () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByText('Go to Command Center')).toBeTruthy();
    expect(screen.getByText('Go to Console')).toBeTruthy();
    expect(screen.getByText('Go to Billing')).toBeTruthy();
  });

  it('renders quick launch prompt banner when user types custom text', async () => {
    const handleRunTask = vi.fn();
    render(<CommandPalette onRunTask={handleRunTask} />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();

    const input = screen.getByPlaceholderText(/Type a mission prompt/i);
    fireEvent.change(input, { target: { value: 'Build quantum router benchmark' } });

    expect(await screen.findByText(/Launch mission:/i)).toBeTruthy();
    const executeBtn = screen.getByText('↵ Execute');
    fireEvent.click(executeBtn);

    expect(handleRunTask).toHaveBeenCalledWith('Build quantum router benchmark');
  });
});
