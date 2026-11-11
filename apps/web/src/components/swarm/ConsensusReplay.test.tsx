import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConsensusReplay, { type ConsensusPayload } from './ConsensusReplay';

const SAMPLE: ConsensusPayload = {
  accepted: true,
  final_proposal: 'ship verify() with tests',
  rounds: 2,
  transcript: [
    { role: 'proposer', agent_id: 'proposer', content: 'broken implementation' },
    { role: 'critic', agent_id: 'critic-a', content: 'needs tests' },
    { role: 'judge', agent_id: 'judge', content: 'revise: add tests' },
    { role: 'proposer', agent_id: 'proposer', content: 'ship verify() with tests' },
    { role: 'judge', agent_id: 'judge', content: 'consensus accepted' },
  ],
  critiques: [],
  test_output: 'ok passed',
};

vi.mock('@/lib/api_client', () => ({
  unifiedApi: { groupchatConsensus: vi.fn() },
}));

afterEach(() => vi.clearAllMocks());

describe('ConsensusReplay', () => {
  it('renders replay controls and first turn from prop', () => {
    render(<ConsensusReplay consensus={SAMPLE} autoFetch={false} />);
    expect(screen.getByTestId('consensus-replay')).toBeDefined();
    expect(screen.getByText('broken implementation')).toBeDefined();
    expect(screen.queryByText('consensus accepted')).toBeNull();
  });

  it('scrubs forward through transcript turns', async () => {
    const user = userEvent.setup();
    render(<ConsensusReplay consensus={SAMPLE} autoFetch={false} />);
    await user.click(screen.getByLabelText('Next turn'));
    expect(screen.getByText('needs tests')).toBeDefined();
  });

  it('shows final proposal in footer', () => {
    render(<ConsensusReplay consensus={SAMPLE} autoFetch={false} />);
    expect(screen.getByText('ship verify() with tests')).toBeDefined();
  });
});
