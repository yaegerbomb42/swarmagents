import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import GlassCard from './GlassCard';

describe('GlassCard', () => {
  it('renders title, body, and variant classes', () => {
    render(
      <GlassCard title="Swarm Node" subtitle="LIVE" variant="purple">
        Telemetry online
      </GlassCard>,
    );

    expect(screen.getByTestId('glass-card')).toHaveClass('glass-card--purple');
    expect(screen.getByText('Swarm Node')).toBeDefined();
    expect(screen.getByText('LIVE')).toBeDefined();
    expect(screen.getByText('Telemetry online')).toBeDefined();
  });

  it('exposes accessible region label and heading', () => {
    render(
      <GlassCard title="Swarm Node" subtitle="LIVE">
        Telemetry online
      </GlassCard>,
    );
    const card = screen.getByTestId('glass-card');
    expect(card.getAttribute('role')).toBe('region');
    expect(card.getAttribute('aria-label')).toBe('Swarm Node');
    expect(screen.getByRole('heading', { level: 3, name: 'Swarm Node' })).toBeDefined();
  });

  it('renders optional footer', () => {
    render(
      <GlassCard footer={<span>99.2% uptime</span>}>
        Body
      </GlassCard>,
    );
    expect(screen.getByText('99.2% uptime')).toBeDefined();
  });

  it('is keyboard focusable when interactive', () => {
    render(<GlassCard title="Focus target">Body</GlassCard>);
    const card = screen.getByTestId('glass-card');
    expect(card.getAttribute('tabindex')).toBe('0');
  });

  it('is not tabbable when interactive is false', () => {
    render(
      <GlassCard interactive={false} title="Static">
        Body
      </GlassCard>,
    );
    expect(screen.getByTestId('glass-card').getAttribute('tabindex')).toBeNull();
  });
});
