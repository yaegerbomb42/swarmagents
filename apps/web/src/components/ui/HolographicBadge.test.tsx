import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HolographicBadge from './HolographicBadge';

describe('HolographicBadge', () => {
  it('renders label with live variant', () => {
    render(<HolographicBadge label="LIVE" variant="live" />);
    expect(screen.getByTestId('holographic-badge')).toBeDefined();
    expect(screen.getByText('LIVE')).toBeDefined();
  });

  it('omits pulse dot when pulse is false', () => {
    const { container } = render(
      <HolographicBadge label="3D" variant="cyan" pulse={false} />,
    );
    expect(container.querySelector('.hyper-holo-badge__dot')).toBeNull();
  });
});
