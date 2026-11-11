// ════════════════════════════════════════════════════════════
//  MobileCommandDeckSheet.test.tsx
// ════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MobileCommandDeckSheet from '@/components/panels/MobileCommandDeckSheet';

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('@/components/fleet/FleetTelemetryStrip', () => ({
  default: ({ className }: { className?: string }) => (
    <div data-testid="fleet-telemetry-strip" className={className}>
      Fleet Telemetry Strip
    </div>
  ),
}));

vi.mock('@/hooks/useSwarmTelemetry', () => ({
  useSwarmTelemetry: () => ({
    workers: [],
    journal: [
      'swarm active · 4 agents · 2 active / 1 queued',
      'engine healthy · 18 done · 421230 tokens',
    ],
    phase: 'executing',
    engineReachable: true,
    lastUpdate: Date.now(),
    counts: {
      agents: 4,
      activeTasks: 2,
      queuedTasks: 1,
      completedTasks: 18,
      totalTokens: 421230,
      avgLatencyMs: 340,
      throughput: 3,
      health: 98,
    },
  }),
}));

// Stub global fetch to avoid real network calls in Queue tab
const fetchSpy = vi.fn(() =>
  Promise.resolve({
    ok: false,
    status: 503,
    json: () => Promise.resolve({}),
  } as Response),
);

// ── Environment stubs ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  // Minimal visualViewport stub
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: {
      offsetTop: 0,
      height: window.innerHeight,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MobileCommandDeckSheet', () => {
  it('renders nothing when isOpen is false', () => {
    render(
      <MobileCommandDeckSheet isOpen={false} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('mobile-command-deck-sheet')).toBeNull();
  });

  it('renders the dialog when isOpen is true', () => {
    render(
      <MobileCommandDeckSheet isOpen onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('mobile-command-deck-sheet')).toBeTruthy();
    // "Command Deck" label should appear in header
    expect(screen.getByText(/Command Deck/i)).toBeTruthy();
  });

  it('renders all 3 tabs: Fleet, Queue, Terminal', () => {
    render(
      <MobileCommandDeckSheet isOpen onClose={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: /Fleet/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Queue/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Terminal/i })).toBeTruthy();
  });

  it('Fleet tab is selected by default and shows telemetry strip', () => {
    render(
      <MobileCommandDeckSheet isOpen onClose={vi.fn()} />,
    );
    const fleetTab = screen.getByRole('tab', { name: /Fleet/i });
    expect(fleetTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('fleet-telemetry-strip')).toBeTruthy();
  });

  it('switches to Queue tab when clicked', async () => {
    render(
      <MobileCommandDeckSheet isOpen onClose={vi.fn()} />,
    );
    const queueTab = screen.getByRole('tab', { name: /Queue/i });
    fireEvent.click(queueTab);
    expect(queueTab).toHaveAttribute('aria-selected', 'true');
    // Queue tab renders either tasks or "queue empty" after fetch resolves
    await waitFor(() => {
      const pending = screen.queryByText(/pending tasks/i);
      expect(pending).toBeTruthy();
    });
  });

  it('switches to Terminal tab and shows journal lines', async () => {
    render(
      <MobileCommandDeckSheet isOpen onClose={vi.fn()} />,
    );
    const terminalTab = screen.getByRole('tab', { name: /Terminal/i });
    fireEvent.click(terminalTab);
    expect(terminalTab).toHaveAttribute('aria-selected', 'true');
    // Should show the mocked journal line
    await waitFor(() => {
      expect(screen.getByText(/swarm active/i)).toBeTruthy();
    });
  });

  it('calls onClose when Escape key is pressed', async () => {
    const onClose = vi.fn();
    render(
      <MobileCommandDeckSheet isOpen onClose={onClose} />,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <MobileCommandDeckSheet isOpen onClose={onClose} />,
    );
    const closeBtn = screen.getByRole('button', { name: /close command deck/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <MobileCommandDeckSheet isOpen onClose={onClose} />,
    );
    // The backdrop has aria-hidden so we select it by its sibling relationship
    // Clicking outside the sheet (on the backdrop)
    const dialog = screen.getByRole('dialog');
    // Find the backdrop (it is the previous sibling of the dialog in the DOM)
    const backdrop = dialog.previousElementSibling;
    expect(backdrop).not.toBeNull();
    if (backdrop) {
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });
});
