import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExportMissionReportButton from './ExportMissionReportButton';

// ---------------------------------------------------------------------------
// Global mocks
// ---------------------------------------------------------------------------

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
      <div {...props}>{children}</div>
    ),
    span: ({ children, ...props }: React.ComponentPropsWithoutRef<'span'>) => (
      <span {...props}>{children}</span>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Clipboard stub
const writeTextMock = vi.fn().mockResolvedValue(undefined);

// Keep a reference to the real createElement so we can delegate to it
const realCreateElement = document.createElement.bind(document);

beforeEach(() => {
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: writeTextMock },
  });
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  });

  // Intercept anchor creation to prevent real navigation/download side-effects
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const el = realCreateElement(tag, options);
    if (tag === 'a') {
      vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => { /* no-op */ });
    }
    return el;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExportMissionReportButton', () => {
  it('renders the export button', () => {
    render(<ExportMissionReportButton sessionId="sess-001" missionLabel="Test Mission" />);
    const btn = screen.getByRole('button', { name: /export mission report/i });
    expect(btn).toBeTruthy();
    expect(screen.getByText('Export')).toBeTruthy();
  });

  it('shows popover with JSON, Markdown, and Share options on click', async () => {
    render(<ExportMissionReportButton sessionId="sess-001" missionLabel="Alpha" />);

    const trigger = screen.getByRole('button', { name: /export mission report/i });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu', { name: /export options/i });
    expect(menu).toBeTruthy();

    expect(screen.getByText('JSON')).toBeTruthy();
    expect(screen.getByText('Markdown')).toBeTruthy();
    expect(screen.getByText('Share link')).toBeTruthy();
  });

  it('closes the popover on Escape key', async () => {
    render(<ExportMissionReportButton sessionId="sess-002" missionLabel="Beta" />);

    fireEvent.click(screen.getByRole('button', { name: /export mission report/i }));
    await screen.findByRole('menu');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('closes the popover on outside click', async () => {
    const { container } = render(
      <div>
        <ExportMissionReportButton sessionId="sess-003" missionLabel="Gamma" />
        <div data-testid="outside">outside</div>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: /export mission report/i }));
    await screen.findByRole('menu');

    fireEvent.mouseDown(container.querySelector('[data-testid="outside"]')!);

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('triggers Markdown download without fetch', async () => {
    render(<ExportMissionReportButton sessionId="sess-004" missionLabel="Delta" />);

    // Set the spy AFTER render so React can mount without interference
    const appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);

    fireEvent.click(screen.getByRole('button', { name: /export mission report/i }));
    await screen.findByRole('menu');

    fireEvent.click(screen.getByText('Markdown'));

    // Popover should close
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });

    appendChildSpy.mockRestore();
  });

  it('copies share link to clipboard and shows toast', async () => {
    render(<ExportMissionReportButton sessionId="sess-005" missionLabel="Epsilon" />);
    fireEvent.click(screen.getByRole('button', { name: /export mission report/i }));
    await screen.findByRole('menu');

    fireEvent.click(screen.getByText('Share link'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining('/decomp?session=sess-005'),
      );
    });

    expect(await screen.findByText('Share link copied!')).toBeTruthy();
  });

  it('disables JSON and Share options when sessionId is absent', async () => {
    render(<ExportMissionReportButton missionLabel="No Session" />);
    fireEvent.click(screen.getByRole('button', { name: /export mission report/i }));
    await screen.findByRole('menu');

    const jsonBtn = screen.getByText('JSON').closest('button');
    const shareBtn = screen.getByText('Share link').closest('button');

    expect(jsonBtn).toHaveProperty('disabled', true);
    expect(shareBtn).toHaveProperty('disabled', true);
  });
});
