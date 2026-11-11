import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RouteError from '@/app/error';
import GlobalError from '@/app/global-error';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

function makeError(message = 'boom', digest?: string) {
  const err = new Error(message) as Error & { digest?: string };
  err.digest = digest;
  return err;
}

describe('RouteError boundary (src/app/error.tsx)', () => {
  it('renders message, digest, and recovery actions; reset recovers', () => {
    const reset = vi.fn();
    const { rerender } = render(<RouteError error={makeError('telemetry socket lost', 'dg-42')} reset={reset} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('telemetry socket lost')).toBeTruthy();
    expect(screen.getByText(/digest dg-42/)).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    expect(reset).toHaveBeenCalledTimes(1);

    // recovery path: parent re-renders with children once reset clears the error
    rerender(<RouteError error={makeError('telemetry socket lost', 'dg-42')} reset={reset} />);
    expect(screen.getByRole('alert')).toBeTruthy();

    expect(screen.getByText('Return to Home').closest('a')?.getAttribute('href')).toBe('/');
  });

  it('omits digest line when absent and surfaces fallback message', () => {
    render(<RouteError error={makeError('')} reset={vi.fn()} />);
    expect(screen.queryByText(/digest/)).toBeNull();
    expect(screen.getByText(/unexpected error occurred/i)).toBeTruthy();
  });
});

describe('GlobalError boundary (src/app/global-error.tsx)', () => {
  it('renders its own document shell, alert, and full-reload affordance', () => {
    const reset = vi.fn();
    render(<GlobalError error={makeError('layout crash', 'gx-1')} reset={reset} />);

    expect(document.querySelector('html')).toBeTruthy();
    expect(document.querySelector('body')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('layout crash')).toBeTruthy();
    expect(screen.getByText(/digest gx-1/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);

    const reload = screen.getByText('Reload app').closest('a');
    expect(reload?.getAttribute('href')).toBe('/');
  });
});
