import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FleetDiffReviewPanel from './FleetDiffReviewPanel';

const SAMPLE = `--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,1 @@
-old
+new
`;

describe('FleetDiffReviewPanel', () => {
  it('shows empty state when no patch is available', () => {
    render(<FleetDiffReviewPanel filename="foo.ts" diffText="" />);
    expect(screen.getByTestId('fleet-diff-review-empty')).toBeDefined();
    expect(screen.getByText(/No fleet patch queued/)).toBeDefined();
  });

  it('renders StreamingDiffGutter when patch text is present', () => {
    render(<FleetDiffReviewPanel filename="foo.ts" diffText={SAMPLE} />);
    expect(screen.getByTestId('streaming-diff-gutter')).toBeDefined();
    expect(screen.getByText('old')).toBeDefined();
    expect(screen.getByText('new')).toBeDefined();
  });

  it('forwards approve/reject callbacks', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <FleetDiffReviewPanel
        filename="foo.ts"
        diffText={SAMPLE}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await user.click(screen.getByText('Approve'));
    await user.click(screen.getByText('Reject'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
