import { Suspense } from 'react';
import { PLANS } from '@/lib/plans';
import { MODEL_PRICES, CREDIT_USD } from '@/lib/modelPricing';
import PricingClient from '@/components/billing/PricingClient';
import CheckoutReturn from '@/components/billing/CheckoutReturn';

export const dynamic = 'force-dynamic';

export default function PricingPage() {
  const models = Object.values(MODEL_PRICES).sort(
    (a, b) => a.creditsPer1KInput - b.creditsPer1KInput
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-12">
      <Suspense>
        <CheckoutReturn />
      </Suspense>

      <header className="mb-12 text-center">
        <h1 className="text-4xl font-bold text-zinc-50 mb-3">
          Scale your swarm without scaling your bill
        </h1>
        <p className="text-zinc-400 max-w-2xl mx-auto">
          Predictable agent pricing. Every plan includes the full model matrix — OpenAI, Anthropic,
          Azure, Google, xAI, DeepSeek, Moonshot, Groq, Mistral, Cohere — with rate limits and
          quota controls designed for production teams. Metered overage at cost+20% when you
          burst past the included credit pool.
        </p>
      </header>

      <PricingClient plans={PLANS} />

      <section className="mt-16">
        <h2 className="text-xl font-semibold text-zinc-100 mb-2">FAQ</h2>
        <div className="space-y-4 text-sm text-zinc-300">
          <details className="border-b border-zinc-800 pb-3">
            <summary className="cursor-pointer font-medium">What's a credit?</summary>
            <p className="mt-2 text-zinc-400">
              1 credit = ${CREDIT_USD.toFixed(3)} USD. Token billing: each model has a per-1K-token
              input/output rate applied against your balance. Included plan credits are renewed
              monthly. Overage is metered and charged at cost+20% on your next invoice.
            </p>
          </details>
          <details className="border-b border-zinc-800 pb-3">
            <summary className="cursor-pointer font-medium">
              Can I bring my own API keys?
            </summary>
            <p className="mt-2 text-zinc-400">
              Yes — BYOK is first-class on every plan. Pro and Team include all 11 providers. You
              only burn SwarmAgents credits on platform-managed models; your own-provider traffic
              is free of platform charges. Rate limits and pool routing still apply.
            </p>
          </details>
          <details className="border-b border-zinc-800 pb-3">
            <summary className="cursor-pointer font-medium">
              How does model pool routing work?
            </summary>
            <p className="mt-2 text-zinc-400">
              Each role (commander, coder, verifier, researcher, browser, summarizer) can either
              pin a single model or rotate through a pool. Pool strategies: round-robin, weighted
              random, least-cost, or fastest. Routing resolves on the engine, not the browser —
              no client-side key leaks.
            </p>
          </details>
          <details className="border-b border-zinc-800 pb-3">
            <summary className="cursor-pointer font-medium">What happens if I hit my cap?</summary>
            <p className="mt-2 text-zinc-400">
              Workloads pause — never surprise-bill you. Bump the cap in settings, or let the next
              billing cycle top you up. Plans can be upgraded, downgraded, or canceled at any time
              from the Customer Portal.
            </p>
          </details>
        </div>
      </section>

      <section className="mt-16">
        <h2 className="text-xl font-semibold text-zinc-100 mb-4">Model prices</h2>
        <p className="text-sm text-zinc-500 mb-4">
          Credits charged per 1K tokens. Prices marked 20% over Azure list as of 2026-08.
        </p>
        <div className="overflow-x-auto border border-zinc-800 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-zinc-400 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Model</th>
                <th className="px-4 py-3 font-medium text-right">Input / 1K</th>
                <th className="px-4 py-3 font-medium text-right">Output / 1K</th>
                <th className="px-4 py-3 font-medium text-right">Azure list (in/out)</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {models.map((m) => (
                <tr key={m.modelId} className="border-t border-zinc-800">
                  <td className="px-4 py-2 font-mono text-xs">{m.modelId}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {m.creditsPer1KInput.toFixed(2)} cr
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {m.creditsPer1KOutput.toFixed(2)} cr
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-500 text-xs">
                    ${m.azureListUsdPer1KInput.toFixed(5)} / ${m.azureListUsdPer1KOutput.toFixed(5)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
