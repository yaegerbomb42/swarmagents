import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiffViewer from './DiffViewer';

vi.mock('@/hooks/useDiffStream', () => ({
  useDiffStream: vi.fn(() => ({
    diffText: '',
    filename: 'live.ts',
    streaming: true,
    done: false,
    error: null,
  })),
  usePatchActions: vi.fn(() => ({
    status: 'idle',
    approve: vi.fn(),
    reject: vi.fn(),
  })),
}));

const SAMPLE = `@@ -1,1 +1,1 @@
-old line
+new line`;

describe('DiffViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders filename and +/- counts', () => {
    render(<DiffViewer filename="app.ts" diffText={SAMPLE} streaming={false} />);
    expect(screen.getByText('app.ts')).toBeDefined();
    expect(screen.getByText('+1')).toBeDefined();
    expect(screen.getByText('-1')).toBeDefined();
  });

  it('shows approve/reject controls when callbacks provided', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(
      <DiffViewer
        filename="x.ts"
        diffText={SAMPLE}
        streaming={false}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
    await user.click(screen.getByText('Approve'));
    await user.click(screen.getByText('Reject'));
    expect(onApprove).toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
  });

  it('shows approve/reject when liveStream with sessionId', async () => {
    const { useDiffStream, usePatchActions } = await import('@/hooks/useDiffStream');
    vi.mocked(useDiffStream).mockReturnValue({
      diffText: SAMPLE,
      filename: 'x.ts',
      streaming: false,
      done: true,
      error: null,
    });
    const approve = vi.fn();
    const reject = vi.fn();
    vi.mocked(usePatchActions).mockReturnValue({
      status: 'idle',
      approve,
      reject,
    });

    const user = userEvent.setup();
    render(
      <DiffViewer
        filename="x.ts"
        diffText=""
        liveStream
        sessionId="sess-1"
      />
    );
    expect(screen.getByText('Approve')).toBeDefined();
    expect(screen.getByText('Reject')).toBeDefined();
    await user.click(screen.getByText('Approve'));
    expect(approve).toHaveBeenCalled();
  });
});
