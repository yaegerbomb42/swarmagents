import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SwarmLabMaster from './SwarmLabMaster';

describe('SwarmLabMaster Component', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, roles: [] }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the two lab views with Create Agent selected by default', () => {
    render(<SwarmLabMaster />);
    expect(screen.getByRole('heading', { name: /Agent Lab/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Agent' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByText(/Create a new agent type/i)).toBeInTheDocument();
  });

  it('switches between the Create Agent and Library views', () => {
    render(<SwarmLabMaster />);

    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Create Agent' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    // Library view filter pills are rendered
    expect(screen.getByRole('button', { name: /My Library/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Global Library/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
    expect(screen.getByText(/Create a new agent type/i)).toBeInTheDocument();
  });
});
