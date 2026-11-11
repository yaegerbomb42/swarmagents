import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HumanCheckpointGateModal from './HumanCheckpointGateModal';

describe('HumanCheckpointGateModal', () => {
  it('renders modal when open prop is true', () => {
    render(
      <HumanCheckpointGateModal
        open={true}
        onClose={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByText('Mission Gate Approval Required')).toBeInTheDocument();
    expect(screen.getByText('HITL Gate')).toBeInTheDocument();
    expect(screen.getAllByText('Atomic file write to production deployment config').length).toBeGreaterThan(0);
  });

  it('calls onApprove with selected action IDs', () => {
    const approveSpy = vi.fn();
    const closeSpy = vi.fn();
    render(
      <HumanCheckpointGateModal
        open={true}
        onClose={closeSpy}
        onApprove={approveSpy}
        onReject={vi.fn()}
      />
    );

    const approveBtn = screen.getByText(/Approve & Proceed/i);
    fireEvent.click(approveBtn);

    expect(approveSpy).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('calls onReject with rejected action IDs', () => {
    const rejectSpy = vi.fn();
    const closeSpy = vi.fn();
    render(
      <HumanCheckpointGateModal
        open={true}
        onClose={closeSpy}
        onApprove={vi.fn()}
        onReject={rejectSpy}
      />
    );

    const rejectBtn = screen.getByText(/Reject Selected/i);
    fireEvent.click(rejectBtn);

    expect(rejectSpy).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });
});
