import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import KeyboardShortcutsModal from './KeyboardShortcutsModal';

describe('KeyboardShortcutsModal', () => {
  it('renders modal when open prop is true', () => {
    render(<KeyboardShortcutsModal open={true} />);
    expect(screen.getByText('Keyboard Navigation HUD')).toBeInTheDocument();
    expect(screen.getByText('Global Navigation')).toBeInTheDocument();
    expect(screen.getByText('DAG & Console')).toBeInTheDocument();
    expect(screen.getByText('Execution & Mission Controls')).toBeInTheDocument();
  });

  it('renders key badges for shortcuts', () => {
    render(<KeyboardShortcutsModal open={true} />);
    expect(screen.getByText('Open omnibar command palette')).toBeInTheDocument();
    expect(screen.getByText('Traverse to next DAG node')).toBeInTheDocument();
  });

  it('calls onClose when Dismiss button is clicked', () => {
    let closed = false;
    render(<KeyboardShortcutsModal open={true} onClose={() => { closed = true; }} />);
    const dismissBtn = screen.getByText('Dismiss');
    fireEvent.click(dismissBtn);
    expect(closed).toBe(true);
  });
});
