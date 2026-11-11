import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HoloShimmerText } from './holo-shimmer-text';

describe('HoloShimmerText', () => {
  it('renders children inside shimmer wrapper', () => {
    render(<HoloShimmerText as="h1">swarmagents.codes</HoloShimmerText>);
    expect(screen.getByRole('heading', { level: 1, name: 'swarmagents.codes' })).toBeDefined();
  });
});
