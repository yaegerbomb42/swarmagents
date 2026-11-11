import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProviderList from './ProviderList';
import type { ProviderItem } from './ProviderList';

const providers: ProviderItem[] = [
  { name: 'azure-foundry', endpoint: 'https://swarmagents.azure-api.net', enabled: true },
  { name: 'ollama', endpoint: 'http://localhost:11434', enabled: true },
  { name: 'openai', endpoint: 'https://api.openai.com/v1', enabled: false },
];

describe('ProviderList', () => {
  it('renders all providers', () => {
    render(<ProviderList providers={providers} onToggle={vi.fn()} />);
    expect(screen.getByText('azure-foundry')).toBeDefined();
    expect(screen.getByText('ollama')).toBeDefined();
    expect(screen.getByText('openai')).toBeDefined();
  });

  it('shows enabled/disabled state', () => {
    render(<ProviderList providers={providers} onToggle={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0].textContent).toBe('Enabled');
    expect(buttons[2].textContent).toBe('Disabled');
  });

  it('calls onToggle with provider name', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ProviderList providers={providers} onToggle={onToggle} />);
    await user.click(screen.getAllByRole('button')[0]);
    expect(onToggle).toHaveBeenCalledWith('azure-foundry');
  });
});
