import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AuroraMesh from './AuroraMesh';
import HolographicBadge from './HolographicBadge';
import DataStreamTicker from './DataStreamTicker';
import HudCorners from './HudCorners';
import ChromaticText from './ChromaticText';

describe('AuroraMesh', () => {
  it('renders aurora blobs', () => {
    const { container } = render(<AuroraMesh />);
    expect(container.querySelector('.hyper-aurora')).toBeTruthy();
    expect(container.querySelectorAll('.hyper-aurora__blob')).toHaveLength(3);
  });

  it('can hide grain', () => {
    const { container } = render(<AuroraMesh showGrain={false} />);
    expect(container.querySelector('.hyper-grain')).toBeNull();
  });
});

describe('HolographicBadge', () => {
  it('renders label', () => {
    render(<HolographicBadge label="LIVE" />);
    expect(screen.getByText('LIVE')).toBeTruthy();
  });
});

describe('DataStreamTicker', () => {
  it('renders ticker track', () => {
    const { container } = render(<DataStreamTicker />);
    expect(container.querySelector('.hyper-data-stream__track')).toBeTruthy();
  });
});

describe('HudCorners', () => {
  it('renders four corners and children', () => {
    render(
      <HudCorners>
        <p>content</p>
      </HudCorners>,
    );
    expect(screen.getByText('content')).toBeTruthy();
    expect(document.querySelectorAll('.hyper-hud__corner')).toHaveLength(4);
  });
});

describe('ChromaticText', () => {
  it('renders text with data-text attr', () => {
    render(<ChromaticText>Hello</ChromaticText>);
    const el = screen.getByTestId('chromatic-text');
    expect(el.textContent).toBe('Hello');
    expect(el.getAttribute('data-text')).toBe('Hello');
  });
});
