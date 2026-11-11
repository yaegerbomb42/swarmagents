/**
 * Subscription plan tiers — monthly+annual handled at Stripe Price level.
 * The "credits" model for usage unchanged: each plan grants a monthly credit
 * allotment, then metered overage bills against the same credit balance.
 *
 * Overage: 1 credit = $0.001 USD, reported to Stripe monthly as metered usage.
 */
export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';

export interface PlanSpec {
  tier: PlanTier;
  label: string;
  monthlyUsdCents: number;
  annualUsdCents: number; // total for the year (10 months free equivalent)
  monthlyCredits: number;
  seats: number; // -1 = unlimited/variable
  highlight: boolean;
  features: string[];
  tagline: string;
  // engine-side gates
  byokRequired: boolean; // if true, plan MUST have own keys
  overageAllowed: boolean;
  // Hints for Stripe (env-driven price IDs)
  stripeMonthlyEnv: string;
  stripeAnnualEnv: string;
}

export const PLANS: PlanSpec[] = [
  {
    tier: 'free',
    label: 'Starter',
    monthlyUsdCents: 0,
    annualUsdCents: 0,
    monthlyCredits: 500,
    seats: 1,
    highlight: false,
    features: [
      '500 credits one-time',
      'Bring your own keys (BYOK)',
      '1 concurrent project',
      'Community support',
    ],
    tagline: 'Evaluate the swarm',
    byokRequired: true,
    overageAllowed: false,
    stripeMonthlyEnv: '',
    stripeAnnualEnv: '',
  },
  {
    tier: 'pro',
    label: 'Pro',
    monthlyUsdCents: 4_900,
    annualUsdCents: 49_000,
    monthlyCredits: 75_000,
    seats: 1,
    highlight: true,
    features: [
      '$75 in credits every month',
      'All providers: OpenAI, Anthropic, Azure, Google, xAI, DeepSeek, Moonshot, Groq, Mistral, Cohere',
      'Model pool routing (round-robin, weighted, cost, fastest)',
      'Unlimited projects',
      'Priority queue',
      'Metered overage at cost+20%',
    ],
    tagline: 'Solo pro · most popular',
    byokRequired: false,
    overageAllowed: true,
    stripeMonthlyEnv: 'STRIPE_PRICE_PRO_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_PRO_ANNUAL',
  },
  {
    tier: 'team',
    label: 'Team',
    monthlyUsdCents: 19_900,
    annualUsdCents: 199_000,
    monthlyCredits: 250_000,
    seats: 5,
    highlight: false,
    features: [
      '$250 in credits every month',
      'Everything in Pro',
      '5 agents included, $30/mo per extra agent',
      'Shared model pools + admin controls',
      'Audit log + role-based usage limits',
      'Engine-side rate limits per agent',
    ],
    tagline: 'For multi-agent startups',
    byokRequired: false,
    overageAllowed: true,
    stripeMonthlyEnv: 'STRIPE_PRICE_TEAM_MONTHLY',
    stripeAnnualEnv: 'STRIPE_PRICE_TEAM_ANNUAL',
  },
  {
    tier: 'enterprise',
    label: 'Enterprise',
    monthlyUsdCents: 0,
    annualUsdCents: 0,
    monthlyCredits: 0,
    seats: -1,
    highlight: false,
    features: [
      'SSO + SAML',
      'Dedicated Azure quota',
      'SLA + 24h support',
      'Invoice billing',
      'Custom rate limits + overage cap',
      'Onboarded BYOK for orgs',
    ],
    tagline: 'Procurement-grade',
    byokRequired: false,
    overageAllowed: true,
    stripeMonthlyEnv: '',
    stripeAnnualEnv: '',
  },
];

export function getPlan(tier: string): PlanSpec {
  const p = PLANS.find((x) => x.tier === tier);
  if (!p) throw new Error(`Unknown plan "${tier}"`);
  return p;
}

export function isPaidPlan(t: string): boolean {
  return t === 'pro' || t === 'team';
}

/** Per-plan enforcement limits — engine-side. Tune conservatively. */
export interface PlanLimits {
  requestsPerMinute: number;
  concurrentRuns: number;
  maxPoolSize: number;
  byokProviders: number; // max keys allowed (pro = all, team = all, free = 2)
  monthlyOverageUsdCap: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    requestsPerMinute: 10,
    concurrentRuns: 1,
    maxPoolSize: 2,
    byokProviders: 2,
    monthlyOverageUsdCap: 0,
  },
  pro: {
    requestsPerMinute: 240,
    concurrentRuns: 3,
    maxPoolSize: 8,
    byokProviders: 11,
    monthlyOverageUsdCap: 500,
  },
  team: {
    requestsPerMinute: 600,
    concurrentRuns: 10,
    maxPoolSize: 12,
    byokProviders: 11,
    monthlyOverageUsdCap: 2_000,
  },
  enterprise: {
    requestsPerMinute: 5_000,
    concurrentRuns: 100,
    maxPoolSize: 32,
    byokProviders: 11,
    monthlyOverageUsdCap: 10_000,
  },
};

export function getPlanLimits(tier: string): PlanLimits {
  return PLAN_LIMITS[(tier as PlanTier)] || PLAN_LIMITS.free;
}
