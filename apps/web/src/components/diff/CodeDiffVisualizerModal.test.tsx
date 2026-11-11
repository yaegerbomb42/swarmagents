import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CodeDiffVisualizerModal from './CodeDiffVisualizerModal';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/hooks/useDiffStream', () => ({
  useDiffStream: vi.fn(() => ({
    diffText: '',
    filename: 'mock.ts',
    streaming: false,
    done: true,
    error: null,
  })),
  usePatchActions: vi.fn(() => ({
    status: 'idle',
    approve: vi.fn(),
    reject: vi.fn(),
  })),
}));

// Stub navigator.clipboard
const writeTextMock = vi.fn(() => Promise.resolve());
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  writable: true,
  configurable: true,
});

const BASE_PROPS = {
  isOpen: true,
  onClose: vi.fn(),
  before: 'const x = 1;\n',
  after: 'const x = 42;\n',
  filename: 'src/foo.ts',
  language: 'typescript',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeDiffVisualizerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Renders null / nothing interactive when isOpen=false ────────────

  it('renders null when isOpen is false', () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} isOpen={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // ── 2. Renders dialog role when isOpen=true ────────────────────────────

  it('renders dialog with aria-modal when isOpen is true', () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  // ── 3. Escape key calls onClose ────────────────────────────────────────

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(<CodeDiffVisualizerModal {...BASE_PROPS} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape', bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose on Escape when isOpen=false', () => {
    const onClose = vi.fn();
    render(<CodeDiffVisualizerModal {...BASE_PROPS} isOpen={false} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape', bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── 4. Shows filename when provided ────────────────────────────────────

  it('displays the provided filename', () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} filename="src/components/Button.tsx" />);
    // filename appears in the title (header h2) and possibly the pill
    const titleEl = screen.getByRole('heading', { level: 2 });
    expect(titleEl.textContent).toContain('Button.tsx');
  });

  it('uses title prop when provided', () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} title="My Custom Title" />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('My Custom Title');
  });

  // ── 5. Close button calls onClose ──────────────────────────────────────

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<CodeDiffVisualizerModal {...BASE_PROPS} onClose={onClose} />);
    const closeBtn = screen.getByLabelText(/close diff viewer/i);
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 6. Backdrop click calls onClose ────────────────────────────────────

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<CodeDiffVisualizerModal {...BASE_PROPS} onClose={onClose} />);
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  // ── 7. Language badge renders ───────────────────────────────────────────

  it('shows language badge', () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} language="typescript" />);
    expect(screen.getByLabelText(/language: typescript/i)).toBeDefined();
  });

  // ── 8. Tabs are rendered ────────────────────────────────────────────────

  it('renders Diff and New file tabs', () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} />);
    expect(screen.getByRole('tab', { name: /diff/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /new file/i })).toBeDefined();
  });

  it('Diff tab is selected by default', () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} />);
    const diffTab = screen.getByRole('tab', { name: /diff/i });
    expect(diffTab.getAttribute('aria-selected')).toBe('true');
  });

  // ── 9. Copy button ──────────────────────────────────────────────────────

  it('copy button calls clipboard.writeText with after content', async () => {
    render(<CodeDiffVisualizerModal {...BASE_PROPS} after={'const x = 42;\n'} />);
    const copyBtn = screen.getByLabelText(/copy new file content/i);
    fireEvent.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('const x = 42;'));
  });

  // ── 10. sessionId: shows loading state ─────────────────────────────────

  it('shows loading spinner when sessionId is provided and fetching', () => {
    // Make fetch hang
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    render(<CodeDiffVisualizerModal {...BASE_PROPS} sessionId="sess-abc" />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeDefined();
  });

  // ── 11. sessionId: shows error on failed fetch ──────────────────────────

  it('shows error message when fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)),
    );
    render(<CodeDiffVisualizerModal {...BASE_PROPS} sessionId="sess-bad" />);
    // Wait for error message to appear
    await screen.findByText(/failed to load diff/i);
  });
});
