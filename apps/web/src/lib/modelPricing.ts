/**
 * Model pricing table — credits per 1K tokens.
 *
 * Currency: credits. 1 credit = $0.001 USD.
 * Source: Azure AI Foundry list prices (USD per 1K tokens, as of 2026-08), marked up
 * by MARGIN_MULTIPLIER for gross margin.
 *
 * IMPORTANT: every model selectable in `modelStore.ts` MUST have an entry here.
 * `getModelPrice()` throws on unknown model — never free, never guess.
 */

export const CREDIT_USD = 0.001;
export const CREDITS_PER_USD = 1 / CREDIT_USD; // 1000

/** Gross-margin multiplier. 1.4 = 40% markup over Azure list. */
export const MARGIN_MULTIPLIER = 1.4;

/** Azure AI Foundry list prices (USD per 1K tokens) — public list as of 2026-08. */
const AZURE_LIST_USD_PER_1K: Record<string, { input: number; output: number }> = {
  'DeepSeek-R1': { input: 0.00135, output: 0.0054 },
  'DeepSeek-V4-Pro': { input: 0.00125, output: 0.005 },
  'Llama-4-Maverick-405B': { input: 0.0027, output: 0.0027 },
  'Qwen-3-Max': { input: 0.0016, output: 0.0064 },
  'Mistral-NeMo-12B': { input: 0.00015, output: 0.00015 },
  'Llama-3.2-1B': { input: 0.00002, output: 0.00002 },
  'Phi-4-mini': { input: 0.000075, output: 0.00015 },
  'Phi-3.5-mini': { input: 0.00013, output: 0.00052 },
  'Gemma-3-12B': { input: 0.000125, output: 0.000375 },
  'DeepSeek-V4-Flash': { input: 0.00014, output: 0.00028 },
  'Qwen-3.5-9B': { input: 0.0002, output: 0.0006 },
  'GPT-5.4-Nano': { input: 0.00005, output: 0.0004 },
  'GPT-4o-mini': { input: 0.00015, output: 0.0006 },
  'Llama-3.3-70B': { input: 0.00071, output: 0.00284 },
};

export interface ModelPrice {
  modelId: string;
  creditsPer1KInput: number;
  creditsPer1KOutput: number;
  azureListUsdPer1KInput: number;
  azureListUsdPer1KOutput: number;
}

function toCreditsPer1K(usdPer1K: number): number {
  const raw = (usdPer1K * MARGIN_MULTIPLIER) / CREDIT_USD;
  return Math.ceil(raw * 100) / 100;
}

export const MODEL_PRICES: Record<string, ModelPrice> = Object.fromEntries(
  Object.entries(AZURE_LIST_USD_PER_1K).map(([modelId, p]) => [
    modelId,
    {
      modelId,
      creditsPer1KInput: toCreditsPer1K(p.input),
      creditsPer1KOutput: toCreditsPer1K(p.output),
      azureListUsdPer1KInput: p.input,
      azureListUsdPer1KOutput: p.output,
    },
  ])
);

/** Hard-fail on unknown model — never free. */
export function getModelPrice(modelId: string): ModelPrice {
  const p = MODEL_PRICES[modelId];
  if (!p) {
    throw new Error(
      `Unknown model "${modelId}" — not in MODEL_PRICES. Refusing to bill at zero.`
    );
  }
  return p;
}

/** Compute credit charge for a single LLM call. Fractional credits allowed. */
export function computeDebitCredits(
  modelId: string,
  tokensIn: number,
  tokensOut: number
): number {
  if (tokensIn < 0 || tokensOut < 0) {
    throw new Error('tokensIn/tokensOut must be non-negative');
  }
  const price = getModelPrice(modelId);
  const inCost = (tokensIn / 1000) * price.creditsPer1KInput;
  const outCost = (tokensOut / 1000) * price.creditsPer1KOutput;
  return Math.ceil((inCost + outCost) * 1000) / 1000;
}

export function listPricedModels(): string[] {
  return Object.keys(MODEL_PRICES);
}

export interface CreditPack {
  packId: 'starter' | 'pro' | 'team';
  label: string;
  usdCents: number;
  credits: number;
  bonusLabel: string | null;
}

export const CREDIT_PACKS: CreditPack[] = [
  { packId: 'starter', label: 'Starter', usdCents: 500, credits: 5_000, bonusLabel: null },
  { packId: 'pro', label: 'Pro', usdCents: 2_000, credits: 21_000, bonusLabel: '+5% bonus' },
  { packId: 'team', label: 'Team', usdCents: 5_000, credits: 55_000, bonusLabel: '+10% bonus' },
];

/** One-time signup grant. NOT monthly — monthly is an abuse magnet. */
export const FREE_SIGNUP_CREDITS = 500;

export function getPack(packId: string): CreditPack {
  const p = CREDIT_PACKS.find((x) => x.packId === packId);
  if (!p) throw new Error(`Unknown pack "${packId}"`);
  return p;
}
