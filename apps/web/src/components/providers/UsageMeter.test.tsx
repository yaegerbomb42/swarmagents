import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UsageMeter from './UsageMeter';

describe('UsageMeter', () => {
  it('displays label and percentage', () => {
    render(<UsageMeter label="GPT-4 Usage" value={72} />);
    expect(screen.getByText('GPT-4 Usage')).toBeDefined();
    expect(screen.getByText('72%')).toBeDefined();
  });

  it('clamps value to 0-100', () => {
    render(<UsageMeter label="Over" value={150} />);
    expect(screen.getByText('100%')).toBeDefined();

    render(<UsageMeter label="Under" value={-10} />);
    expect(screen.getByText('0%')).toBeDefined();
  });

  it('sets data-value on the bar', () => {
    render(<UsageMeter label="Test" value={42} />);
    const bar = document.querySelector('[data-value]');
    expect(Number(bar?.getAttribute('data-value'))).toBe(42);
  });
});
