import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConsoleNav, { CONSOLE_TABS } from './ConsoleNav';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/decomp'),
}));

describe('ConsoleNav mobile drawer', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('renders hamburger trigger on mobile', () => {
    render(<ConsoleNav dense />);
    expect(screen.getByLabelText('Open navigation menu')).toBeDefined();
  });

  it('opens drawer with all console tabs', () => {
    render(<ConsoleNav dense />);
    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    const links = screen.getAllByRole('link');
    const labels = links.map((l) => l.textContent);
    for (const tab of CONSOLE_TABS) {
      expect(labels).toContain(tab.label);
    }
  });

  it('closes drawer on Escape', () => {
    render(<ConsoleNav dense />);
    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes drawer when backdrop clicked', () => {
    render(<ConsoleNav dense />);
    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    fireEvent.click(screen.getByLabelText('Close navigation menu'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
