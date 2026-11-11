import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// jsdom in this repo runs without a URL, so window.localStorage is undefined.
// The component reads via window.localStorage — shim it on window directly.
const memStore = new Map<string, string>();
const memStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  get length() { return memStore.size; },
  key: (i: number) => [...memStore.keys()][i] ?? null,
} as Storage;
Object.defineProperty(window, 'localStorage', { value: memStorage, configurable: true });
import FleetBudgetHud, {
  BUDGET_STORAGE_KEY,
  readStoredBudget,
  writeStoredBudget,
} from './FleetBudgetHud';
import { CREDIT_USD } from '@/lib/modelPricing';

const mockBalance = vi.hoisted(() => ({
  current: null as null | { credits: number },
}));

vi.mock('@/hooks/useBalance', () => ({
  useBalance: () => ({
    balance: mockBalance.current,
    loaded: true,
    unavailable: false,
    refresh: vi.fn(),
  }),
}));

/**
 * Realistic /api/agents/costs payload.
 * $0.30 total => 300 credits (CREDIT_USD = 0.001); $0.01/min => 600 cr/h.
 */
const COSTS = {
  ok: true,
  totalCost: 0.3,
  totalCostFormatted: '$0.3000',
  totalInputTokens: 120_000,
  totalOutputTokens: 40_000,
  totalTokens: 160_000,
  callCount: 42,
  runtimeSeconds: 1800,
  runtimeFormatted: '30m 0s',
  costPerMinute: 0.01,
  tokensPerMinute: 5333,
  byProvider: {
    azure: { cost: 0.2, calls: 30, tokens: 120_000 },
    groq: { cost: 0.07, calls: 10, tokens: 30_000 },
    ollama: { cost: 0.02, calls: 2, tokens: 10_000 },
    cerebras: { cost: 0.01, calls: 1, tokens: 5_000 },
  },
};

function mockCosts(payload: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  });
}

beforeEach(() => {
  mockBalance.current = { credits: 5000 };
  memStore.clear();
  vi.stubGlobal('fetch', mockCosts(COSTS));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  memStore.clear();
});

describe('budget persistence', () => {
  it('round-trips a ceiling through localStorage', () => {
    writeStoredBudget(2500);
    expect(readStoredBudget()).toBe(2500);
  });

  it('clears the ceiling when set to zero or negative', () => {
    writeStoredBudget(1000);
    writeStoredBudget(0);
    expect(readStoredBudget()).toBe(0);
  });

  it('ignores corrupt or non-positive stored values', () => {
    window.localStorage.setItem(BUDGET_STORAGE_KEY, 'not-a-number');
    expect(readStoredBudget()).toBe(0);
    window.localStorage.setItem(BUDGET_STORAGE_KEY, '-40');
    expect(readStoredBudget()).toBe(0);
  });
});

describe('FleetBudgetHud', () => {
  it('renders live spend converted into credits', async () => {
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);

    expect(screen.getByTestId('fleet-budget-hud')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('budget-metric-spend')).toHaveTextContent('300 cr');
    });
    expect(screen.getByTestId('budget-metric-burn')).toHaveTextContent('600 cr/h');
    expect(screen.getByTestId('budget-metric-balance')).toHaveTextContent('5000 cr');
    expect(screen.getByTestId('budget-metric-tokens')).toHaveTextContent('160.0k');
    expect(screen.getByTestId('budget-metric-calls')).toHaveTextContent('42');
  });

  it('shows no ceiling until one is configured', async () => {
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-level')).toHaveTextContent('no budget');
    });
    expect(screen.getByTestId('budget-pct')).toHaveTextContent('No ceiling set');
    expect(screen.getByTestId('budget-alarm')).toHaveTextContent('No budget set');
  });

  it('raises a warn alarm and projects runway at 80% of budget', async () => {
    writeStoredBudget(375); // 300 spent / 375 = 80%
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-level')).toHaveTextContent('elevated');
    });
    expect(screen.getByTestId('budget-pct')).toHaveTextContent('80.0% of 375 cr');
    // 75 credits left at 600 cr/h => 7.5 minutes
    expect(screen.getByTestId('budget-metric-runway')).toHaveTextContent('8m');
    expect(screen.getByTestId('budget-alarm')).toHaveTextContent('Spend elevated');
  });
});

describe('FleetBudgetHud — escalation and controls', () => {
  it('escalates to critical above 90% of budget', async () => {
    writeStoredBudget(316); // 300 / 316 = 94.9%
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-level')).toHaveTextContent('critical');
    });
    expect(screen.getByTestId('budget-alarm')).toHaveTextContent('Critical spend');
  });

  it('reports exceeded and zero runway once spend passes the ceiling', async () => {
    writeStoredBudget(100); // 300 spent / 100 => 300%
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-level')).toHaveTextContent('exceeded');
    });
    expect(screen.getByTestId('budget-pct')).toHaveTextContent('300.0%');
    expect(screen.getByTestId('budget-metric-runway')).toHaveTextContent('exhausted');
    expect(screen.getByTestId('budget-alarm')).toHaveTextContent('Budget exceeded');
  });

  it('clamps the progress bar width at 100%', async () => {
    writeStoredBudget(100);
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-level')).toHaveTextContent('exceeded');
    });
    expect(screen.getByTestId('budget-bar')).toHaveStyle({ width: '100%' });
  });

  it('lists the top three providers by spend, descending', async () => {
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-providers')).toBeInTheDocument();
    });
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('azure');
    expect(rows[1]).toContain('groq');
    expect(rows[2]).toContain('ollama');
    expect(rows.join('|')).not.toContain('cerebras');
  });

  it('persists a new ceiling entered in the HUD', async () => {
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-metric-spend')).toHaveTextContent('300 cr');
    });

    const input = screen.getByLabelText('Budget ceiling in credits');
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.click(screen.getByText('set'));

    await waitFor(() => {
      expect(screen.getByTestId('budget-pct')).toHaveTextContent('30.0% of 1000 cr');
    });
    expect(window.localStorage.getItem(BUDGET_STORAGE_KEY)).toBe('1000');
    expect(screen.getByTestId('budget-level')).toHaveTextContent('within budget');
  });

  it('commits the ceiling on Enter', async () => {
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    const input = screen.getByLabelText('Budget ceiling in credits');
    fireEvent.change(input, { target: { value: '600' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('budget-pct')).toHaveTextContent('50.0% of 600 cr');
    });
  });

  it('clears a configured ceiling back to unset', async () => {
    writeStoredBudget(1000);
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByText('clear')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('clear'));
    await waitFor(() => {
      expect(screen.getByTestId('budget-level')).toHaveTextContent('no budget');
    });
    expect(window.localStorage.getItem(BUDGET_STORAGE_KEY)).toBeNull();
  });
});

describe('FleetBudgetHud — resilience', () => {
  it('degrades to an offline alarm when costs are unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-alarm')).toHaveTextContent('Spend telemetry offline');
    });
    expect(screen.getByTestId('budget-metric-spend')).toHaveTextContent('0.0 cr');
  });

  it('surfaces a cost-tracker error payload', async () => {
    vi.stubGlobal('fetch', mockCosts({ ok: false, error: 'tracker exploded' }));
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-alarm')).toHaveTextContent('tracker exploded');
    });
  });

  it('reports non-2xx cost responses', async () => {
    vi.stubGlobal('fetch', mockCosts({}, false));
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-alarm')).toHaveTextContent('HTTP 500');
    });
  });

  it('renders an em-dash balance when billing is unavailable', async () => {
    mockBalance.current = null;
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-metric-spend')).toHaveTextContent('300 cr');
    });
    expect(screen.getByTestId('budget-metric-balance')).toHaveTextContent('—');
  });

  it('keeps the credit rate coupled to modelPricing', async () => {
    // $1 of tracked cost must render as 1/CREDIT_USD credits.
    vi.stubGlobal('fetch', mockCosts({ ...COSTS, totalCost: 1, costPerMinute: 0 }));
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('budget-metric-spend')).toHaveTextContent(
        `${1 / CREDIT_USD} cr`,
      );
    });
  });
});

describe('FleetBudgetHud spend vs balance', () => {
  it('renders engine spend and wallet balance from real endpoints', async () => {
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => expect(screen.getByTestId('fleet-budget-hud')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('budget-metric-spend').textContent).toContain('300'));
    expect(screen.getByTestId('budget-metric-balance').textContent).toContain('5000');
  });

  it('arms the alarm once a persisted ceiling is set', async () => {
    window.localStorage.setItem(BUDGET_STORAGE_KEY, '350');
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => expect(screen.getByTestId('budget-alarm').textContent).toMatch(/elevated|critical|Spend/));
    expect(screen.getByTestId('budget-pct').textContent).toContain('% of 350');
  });

  it('persists a new ceiling from the editor', async () => {
    render(<FleetBudgetHud refreshIntervalMs={60_000} />);
    await waitFor(() => expect(screen.getByTestId('fleet-budget-hud')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Budget ceiling in credits/), { target: { value: '2000' } });
    fireEvent.click(screen.getByText('set'));
    expect(window.localStorage.getItem(BUDGET_STORAGE_KEY)).toBe('2000');
  });
});