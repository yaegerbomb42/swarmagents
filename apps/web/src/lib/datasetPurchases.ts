export interface DatasetProduct {
  sku: string;
  title: string;
  badge: string;
  priceUsd: number;
  /** Stripe amount_total in cents */
  priceCents: number;
  recordsCount: number;
  tokensEstimate: string;
  headline: string;
  description: string;
  features: string[];
  stripeUrl: string;
  archiveFileName: string;
  archiveSizeMb: number;
  sha256: string;
  benchmarkScore: string;
}

export const DATASET_PRODUCTS: Record<string, DatasetProduct> = {
  'lab-starter-2k': {
    sku: 'lab-starter-2k',
    title: 'Lab Starter — 2k Curated Samples',
    badge: '🚀 START HERE',
    priceUsd: 49,
    priceCents: 4900,
    recordsCount: 2000,
    tokensEstimate: '~8M+ Tokens',
    headline: 'Cheap commercial eval pack — same schema as the flagship suites.',
    description: 'Curated starter trajectories spanning systems, fullstack, and agent domains so you can validate training pipelines before buying a full pack.',
    features: [
      '2,000 curated JSONL trajectories (schema-compatible)',
      'Commercial evaluation & fine-tune license',
      'Upgrade credit path toward full packs',
      'Instant download after Stripe checkout'
    ],
    stripeUrl: 'https://buy.stripe.com/7sYeV5bnL1l83Wd6KpaIM0z',
    archiveFileName: 'payload_lab_starter_2k.tar.gz',
    archiveSizeMb: 9,
    sha256: '548414239bbf379f98bda03f0b8d2de0707683dd1f136a0e7b7e2ed5cbff1e39',
    benchmarkScore: 'Eval starter / schema check'
  },
  'master-210k': {
    sku: 'master-210k',
    title: 'Flagship Master Suite (Full 210k + 4 LoRAs)',
    badge: '🏆 FULL ENTERPRISE SUITE',
    priceUsd: 249,
    priceCents: 24900,
    recordsCount: 210276,
    tokensEstimate: '~880M+ Tokens',
    headline: 'The complete multi-domain System-2 reasoning and autonomous coding corpus.',
    description: 'Unified archive including all 3 specialized domains, 4 pre-computed fine-tuned Gemma 4 LoRA adapters, AST invariant validation scripts, and hard SWE-bench evaluation harnesses.',
    features: [
      'Full 210,276 verified JSONL trajectories across all domains',
      'All 4 fine-tuned LoRA adapters (FP16 & GGUF quantized)',
      'Systems Concurrency (93k) + Platinum Fullstack (102k) + Agent Sandbox (15k)',
      'Verified +72 Elo gain and +100% relative improvement on SWE-bench Hard',
      'Evaluation harness, test splits, and SHA-256 verification suite',
      'Commercial royalty-free perpetual training & distribution license'
    ],
    stripeUrl: 'https://buy.stripe.com/bJe4gr8bz6Fs1O55GlaIM0D',
    archiveFileName: 'payload_master_210k.tar.gz',
    archiveSizeMb: 956.8,
    sha256: 'pending-verification',
    benchmarkScore: '1,364 Elo (+72 Gain) / 40.0% Hard Pass@1'
  },
  'systems-93k': {
    sku: 'systems-93k',
    title: 'Pack 1: Systems & Concurrency Invariants',
    badge: '⚡ KERNEL & LOW-LEVEL CONCURRENCY',
    priceUsd: 149,
    priceCents: 14900,
    recordsCount: 92742,
    tokensEstimate: '~390M+ Tokens',
    headline: 'High-rigor low-level systems programming, lock-free memory, and eBPF invariants.',
    description: 'Specialized for training models that write rock-solid systems software in Rust, C, C++, Go, and Zig with memory safety, deadlock prevention, and cache-coherent algorithms.',
    features: [
      '92,742 audited low-level systems trajectories',
      'Lock-free algorithms, atomics, eBPF filters, and zero-copy memory pipelines',
      'Detailed chain-of-thought mathematical and memory invariant proofs',
      'LoRA 1 adapter weights trained on 8x NVIDIA H100 SXM5 GPUs',
      'Proven +100% relative pass rate boost on hard kernel benchmarks',
      'Full commercial internal training & model distribution rights'
    ],
    stripeUrl: 'https://buy.stripe.com/9B6aEPcrP7JwcsJ1q5aIM0C',
    archiveFileName: 'payload_systems_93k.tar.gz',
    archiveSizeMb: 440.3,
    sha256: 'pending-verification',
    benchmarkScore: '1,364 Elo (+72 Gain) / 40.0% Hard Pass@1'
  },
  'fullstack-102k': {
    sku: 'fullstack-102k',
    title: 'Pack 2: Platinum Full-Stack Architecture',
    badge: '🌐 ENTERPRISE FULL-STACK & APIS',
    priceUsd: 129,
    priceCents: 12900,
    recordsCount: 102508,
    tokensEstimate: '~420M+ Tokens',
    headline: 'End-to-end full-stack engineering, microservice migrations, and database transactions.',
    description: 'Engineered for full-stack coding agents handling complex TypeScript/Next.js, Python/FastAPI, GraphQL/REST APIs, database migrations, and cloud-native deployments.',
    features: [
      '102,508 multi-file full-stack architecture trajectories',
      'Complex refactors, atomic schema migrations, and secure auth pipelines',
      'Strict type invariants (TypeScript, Pydantic, Prisma, Drizzle)',
      'LoRA 2 fullstack specialist adapter weights included',
      'Verified zero-regression synthetic validation test cases',
      'Royalty-free commercial enterprise license'
    ],
    stripeUrl: 'https://buy.stripe.com/3cI7sD4Zn4xk9gx8SxaIM0A',
    archiveFileName: 'payload_fullstack_102k.tar.gz',
    archiveSizeMb: 458.4,
    sha256: 'pending-verification',
    benchmarkScore: '1,348 Elo (+56 Gain) / 38.5% Hard Pass@1'
  },
  'agents-15k': {
    sku: 'agents-15k',
    title: 'Pack 3: Multi-Turn Agent Sandbox Episodes',
    badge: '🤖 AUTONOMOUS TOOL & COMPILER SESSIONS',
    priceUsd: 79,
    priceCents: 7900,
    recordsCount: 15026,
    tokensEstimate: '~70M+ Tokens',
    headline: 'Deep interactive tool-use traces, bash execution, compiler error recovery, and git workflows.',
    description: 'Multi-turn episodes of agents navigating real shell environments, analyzing compiler diagnostics, recovering from broken test runs, and completing multi-step coding objectives.',
    features: [
      '15,026 long-horizon multi-turn tool interaction episodes',
      'Shell execution, grep/fd search, diff patching, and test-driven self-correction',
      'Dialectical multi-agent critiques and sub-goal task trees',
      'LoRA 3 agentic reasoning adapter weights included',
      'Standardized OpenAI/Anthropic/Gemini function-calling format',
      'Royalty-free perpetual commercial license'
    ],
    stripeUrl: 'https://buy.stripe.com/00w5kv63re7U1O5d8NaIM0B',
    archiveFileName: 'payload_multiturn_15k.tar.gz',
    archiveSizeMb: 58.0,
    sha256: 'pending-verification',
    benchmarkScore: '1,335 Elo (+43 Gain) / 35.0% Hard Pass@1'
  }
};

const VAULT_STORAGE_KEY = 'swarmagents_purchased_datasets_vault';

export interface UnlockedLicense {
  sku: string;
  unlockedAt: string;
  sessionId?: string;
  email?: string;
  product: DatasetProduct;
}

export function getUnlockedLicenses(): UnlockedLicense[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        ...item,
        product: DATASET_PRODUCTS[item.sku] || DATASET_PRODUCTS['master-210k']
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export function saveUnlockedLicense(sku: string, sessionId?: string, email?: string): void {
  if (typeof window === 'undefined') return;
  try {
    const current = getUnlockedLicenses();
    const exists = current.some((item) => item.sku === sku);
    if (!exists && DATASET_PRODUCTS[sku]) {
      const updated = [
        ...current,
        {
          sku,
          unlockedAt: new Date().toISOString(),
          sessionId,
          email,
          product: DATASET_PRODUCTS[sku]
        }
      ];
      localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
    }
  } catch {
    // Ignore localStorage write issues
  }
}


export function replaceUnlockedLicenses(
  licenses: Array<{ sku: string; sessionId?: string; email?: string }>
): void {
  if (typeof window === 'undefined') return;
  try {
    const updated = licenses
      .filter((item) => DATASET_PRODUCTS[item.sku])
      .map((item) => ({
        sku: item.sku,
        unlockedAt: new Date().toISOString(),
        sessionId: item.sessionId,
        email: item.email,
        product: DATASET_PRODUCTS[item.sku]
      }));
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore localStorage write issues
  }
}

