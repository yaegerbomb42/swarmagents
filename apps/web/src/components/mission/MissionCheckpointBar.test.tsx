import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MissionCheckpointBar from './MissionCheckpointBar';

describe('MissionCheckpointBar', () => {
  it('renders four checkpoint phases', () => {
    render(
      <MissionCheckpointBar
        phases={[
          { id: 'plan', label: 'Plan', status: 'complete' },
          { id: 'implement', label: 'Implement', status: 'active', workers: 3 },
          { id: 'verify', label: 'Verify', status: 'pending' },
          { id: 'ship', label: 'Ship', status: 'pending' },
        ]}
      />,
    );
    expect(screen.getByTestId('mission-checkpoint-bar')).toBeDefined();
    expect(screen.getByTestId('checkpoint-implement').getAttribute('data-status')).toBe('active');
  });
});
