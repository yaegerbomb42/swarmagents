'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  ShieldCheck, Download, Check, ArrowRight, Sparkles, HardDrive,
  Cpu, FileCode, CheckCircle2, Lock, Key, Terminal, HelpCircle, Zap
} from 'lucide-react';
import ConsoleShell from '@/components/ConsoleShell';
import {
  DATASET_PRODUCTS,
  getUnlockedLicenses,
  saveUnlockedLicense,
  replaceUnlockedLicenses,
  type UnlockedLicense,
  type DatasetProduct
} from '@/lib/datasetPurchases';

/** Display order: Lab Starter (entry) then Master (hero) then domain packs */
const PRODUCT_ORDER = [
  'master-210k',
  'lab-starter-2k',
  'agents-15k',
  'fullstack-102k',
  'systems-93k'
] as const;

function pricePer1k(product: DatasetProduct): number {
  if (!product.recordsCount) return 0;
  return (product.priceUsd * 1000) / product.recordsCount;
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 2 : 0 });
}

function formatPer1k(n: number): string {
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}


type VerifyPayload = {
  ok?: unknown;
  paid?: unknown;
  sku?: unknown;
  error?: unknown;
  customer_email?: unknown;
};

/** Only treat a verify response as paid for a known SKU. Never infer from session id alone. */
function paidSkuFromVerify(res: Response, data: VerifyPayload): string | null {
  if (!res.ok) return null;
  if (data.ok !== true || data.paid !== true) return null;
  if (typeof data.sku !== 'string' || !DATASET_PRODUCTS[data.sku]) return null;
  return data.sku;
}

export default function DatasetsPage() {
  const [unlockedLicenses, setUnlockedLicenses] = useState<UnlockedLicense[]>([]);
  const [claimInput, setClaimInput] = useState('');
  const [claimStatus, setClaimStatus] = useState<string | null>(null);
  const [claimFailed, setClaimFailed] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const paidSessionBySku = (sku: string): string | null => {
    const lic = unlockedLicenses.find((item) => item.sku === sku && item.sessionId);
    return lic?.sessionId || null;
  };

  const rememberPaid = (sku: string, sessionId: string, email?: string) => {
    saveUnlockedLicense(sku, sessionId, email);
    setUnlockedLicenses((prev) => {
      const next = prev.filter((item) => item.sku !== sku);
      return [
        ...next,
        {
          sku,
          unlockedAt: new Date().toISOString(),
          sessionId,
          email,
          product: DATASET_PRODUCTS[sku],
        },
      ];
    });
  };

  const orderedProducts = useMemo(
    () =>
      PRODUCT_ORDER.map((sku) => DATASET_PRODUCTS[sku]).filter(Boolean) as DatasetProduct[],
    []
  );

  const master = DATASET_PRODUCTS['master-210k'];
  const lab = DATASET_PRODUCTS['lab-starter-2k'];

  // Hydrate vault only from sessions that verify as paid:true for that SKU.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;

    (async () => {
      const stored = getUnlockedLicenses();
      const urlParams = new URLSearchParams(window.location.search);
      const urlSession = urlParams.get('session_id') || urlParams.get('session');
      const skuParam = urlParams.get('sku') || undefined;
      const pendingSku = localStorage.getItem('swarmagents_pending_checkout_sku') || undefined;

      const checks: Array<{ sessionId: string; sku?: string }> = [];
      for (const lic of stored) {
        if (lic.sessionId) checks.push({ sessionId: lic.sessionId, sku: lic.sku });
      }
      if (urlSession) {
        checks.push({ sessionId: urlSession, sku: skuParam || pendingSku });
      }

      const verified: UnlockedLicense[] = [];
      const seenSku = new Set<string>();
      let urlVerified = false;
      let urlError: string | null = null;

      for (const check of checks) {
        try {
          const res = await fetch('/api/datasets/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              check.sku ? { sessionId: check.sessionId, sku: check.sku } : { sessionId: check.sessionId }
            ),
          });
          const data = (await res.json().catch(() => ({}))) as VerifyPayload;
          if (cancelled) return;
          const paidSku = paidSkuFromVerify(res, data);
          if (!paidSku) {
            if (urlSession && check.sessionId === urlSession) {
              urlError = typeof data.error === 'string' ? data.error : 'complete checkout to unlock';
            }
            continue;
          }
          if (seenSku.has(paidSku)) continue;
          seenSku.add(paidSku);
          verified.push({
            sku: paidSku,
            unlockedAt: new Date().toISOString(),
            sessionId: check.sessionId,
            email: typeof data.customer_email === 'string' ? data.customer_email : undefined,
            product: DATASET_PRODUCTS[paidSku],
          });
          if (urlSession && check.sessionId === urlSession) urlVerified = true;
        } catch {
          if (urlSession && check.sessionId === urlSession) {
            urlError = 'Payment verification failed. Please try again or contact support.';
          }
        }
      }

      if (cancelled) return;
      replaceUnlockedLicenses(verified);
      setUnlockedLicenses(verified);

      if (urlSession) {
        if (urlVerified) {
          const unlockedSku = verified.find((item) => item.sessionId === urlSession)?.sku;
          setClaimFailed(false);
          setClaimStatus(
            `Payment verified. Unlocked ${DATASET_PRODUCTS[unlockedSku || '']?.title || 'dataset'}. Your download is ready below.`
          );
          localStorage.removeItem('swarmagents_pending_checkout_sku');
        } else {
          setClaimFailed(true);
          setClaimStatus(`Payment not verified: ${urlError || 'complete checkout to unlock'}.`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleBuyClick = (sku: string) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('swarmagents_pending_checkout_sku', sku);
    }
  };

  const handleClaimOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const sessionId = claimInput.trim();
    if (!sessionId || claiming) return;

    setClaiming(true);
    setClaimFailed(false);
    setClaimStatus(null);

    try {
      const res = await fetch('/api/datasets/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json().catch(() => ({}))) as VerifyPayload;
      const paidSku = paidSkuFromVerify(res, data);
      if (!paidSku) {
        setClaimFailed(true);
        setClaimStatus(
          (typeof data.error === 'string' && data.error) ||
            'Payment not verified. Enter a real Stripe Checkout session ID (cs_live_… or cs_test_…).'
        );
        return;
      }
      rememberPaid(paidSku, sessionId, typeof data.customer_email === 'string' ? data.customer_email : undefined);
      replaceUnlockedLicenses(
        [
          ...unlockedLicenses.filter((item) => item.sku !== paidSku),
          { sku: paidSku, sessionId, email: typeof data.customer_email === 'string' ? data.customer_email : undefined },
        ]
      );
      setClaimFailed(false);
      setClaimStatus(
        `Payment verified. Unlocked ${DATASET_PRODUCTS[paidSku]?.title || 'dataset'}. Your download is ready below.`
      );
      setClaimInput('');
    } catch {
      setClaimFailed(true);
      setClaimStatus('Payment verification failed. Please try again or contact support.');
    } finally {
      setClaiming(false);
    }
  };

  const masterPaidSession = paidSessionBySku(master.sku);

  return (
      <ConsoleShell missionHint="Post-training datasets" className="pb-32">

      {/* HERO — dual CTA: Master $249 + Lab Starter $49 */}
      <section className="relative overflow-hidden border-b border-cyan-500/10 bg-gradient-to-b from-cyan-950/20 via-black to-[#050508] pt-14 pb-16 px-5 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono font-semibold bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
              COMMERCIAL DATASET LICENSES
            </span>
            <span className="text-xs font-mono text-zinc-400 bg-white/[0.04] px-3 py-1 rounded-full border border-white/10">
              {master.recordsCount.toLocaleString()} RECORDS · {master.tokensEstimate}
            </span>
          </div>

          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black text-white tracking-tight leading-[1.08] uppercase max-w-4xl mb-5">
            Universal <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-teal-300 to-emerald-400">Frontier Reasoning</span> Suite
          </h1>

          <p className="text-zinc-300 text-base sm:text-xl font-light leading-relaxed max-w-3xl mb-8">
            Audited System-2 invariant &amp; multi-turn sandbox trajectories for post-training.
            Start at <span className="text-emerald-300 font-mono font-semibold">{formatUsd(lab.priceUsd)}</span> with Lab Starter,
            or unlock the full <span className="text-cyan-300 font-mono font-semibold">{master.recordsCount.toLocaleString()}-record Master Suite</span> for{' '}
            <span className="text-cyan-300 font-mono font-semibold">{formatUsd(master.priceUsd)}</span>.
          </p>

          {/* Dual primary CTAs */}
          <div className="flex flex-col sm:flex-row flex-wrap gap-3 mb-8">
            <a
              href={master.stripeUrl}
              onClick={() => handleBuyClick(master.sku)}
              className="inline-flex items-center justify-center gap-2.5 px-7 py-4 rounded-2xl bg-gradient-to-r from-cyan-400 to-emerald-400 text-black font-extrabold text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all shadow-[0_0_30px_rgba(0,229,255,0.28)]"
            >
              <Sparkles size={16} /> Get Master Suite — {formatUsd(master.priceUsd)}
            </a>
            <a
              href={lab.stripeUrl}
              onClick={() => handleBuyClick(lab.sku)}
              className="inline-flex items-center justify-center gap-2.5 px-7 py-4 rounded-2xl bg-white/[0.06] hover:bg-white/[0.12] border border-emerald-400/40 text-emerald-200 font-bold text-sm tracking-wide transition"
            >
              <Zap size={16} className="text-emerald-400" /> Try Lab Starter — {formatUsd(lab.priceUsd)}
            </a>
            <a
              href="#pricing"
              className="inline-flex items-center justify-center gap-2 px-5 py-4 rounded-2xl text-zinc-300 hover:text-white text-xs font-mono border border-white/10 hover:border-white/20 transition"
            >
              Compare all packs <ArrowRight size={14} />
            </a>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-4xl">
            <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-center gap-2.5">
              <ShieldCheck size={18} className="text-emerald-400 shrink-0" />
              <span className="text-xs text-zinc-300 font-medium">Stripe Secured Instant Download</span>
            </div>
            <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-center gap-2.5">
              <Cpu size={18} className="text-cyan-400 shrink-0" />
              <span className="text-xs text-zinc-300 font-medium">8x H100 Hardware Proven</span>
            </div>
            <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-center gap-2.5">
              <FileCode size={18} className="text-amber-400 shrink-0" />
              <span className="text-xs text-zinc-300 font-medium">4 LoRA Adapters (Master)</span>
            </div>
            <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-center gap-2.5">
              <CheckCircle2 size={18} className="text-purple-400 shrink-0" />
              <span className="text-xs text-zinc-300 font-medium">Royalty-Free Commercial Rights</span>
            </div>
          </div>
        </div>
      </section>

      <main className="max-w-6xl mx-auto px-5 lg:px-8 pt-12">
        {/* ACCOUNT VAULT */}
        {unlockedLicenses.length > 0 && (
          <div className="mb-14 p-6 sm:p-8 rounded-3xl bg-gradient-to-br from-emerald-950/40 via-zinc-950 to-black border border-emerald-500/30">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 uppercase tracking-widest">
                  <HardDrive size={16} /> My Account License Vault
                </div>
                <div className="text-lg font-bold text-white mt-1">
                  You have {unlockedLicenses.length} unlocked commercial dataset license{unlockedLicenses.length > 1 ? 's' : ''}
                </div>
              </div>
              <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-full border border-emerald-500/30 self-start sm:self-auto">
                Ready to re-download anytime
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {unlockedLicenses.map((lic, idx) => (
                <div key={idx} className="p-5 rounded-2xl bg-black/60 border border-white/10 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-mono text-cyan-400 uppercase">{lic.product.badge}</div>
                    <div className="text-sm font-semibold text-white truncate mt-0.5">{lic.product.title}</div>
                    <div className="text-xs text-zinc-400 font-mono mt-1">
                      {lic.product.recordsCount.toLocaleString()} rows · {lic.product.archiveSizeMb} MB
                    </div>
                  </div>
                  {lic.sessionId ? (
                    <a
                      href={`/api/datasets/download?sku=${encodeURIComponent(lic.sku)}&session_id=${encodeURIComponent(lic.sessionId)}`}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs shrink-0 transition shadow-sm"
                    >
                      <Download size={14} /> Download
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SCARCITY + COMPARISON */}
        <div id="pricing" className="mb-10 scroll-mt-20">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-4">
            <div>
              <div className="text-xs font-mono text-cyan-400 uppercase tracking-widest mb-1">
                Commercial Catalog & Instant Delivery
              </div>
              <h2 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight">
                Pick a Pack — From {formatUsd(lab.priceUsd)}
              </h2>
            </div>
          </div>

          {/* Dual CTA strip at top of pricing */}
          <div className="mb-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <a
              href={master.stripeUrl}
              onClick={() => handleBuyClick(master.sku)}
              className="flex items-center justify-between gap-3 p-4 rounded-2xl border border-cyan-400/40 bg-cyan-950/30 hover:bg-cyan-950/50 transition"
            >
              <div>
                <div className="text-[11px] font-mono text-cyan-400 uppercase">Best value</div>
                <div className="text-sm font-bold text-white">Master Suite · {master.recordsCount.toLocaleString()} rows</div>
              </div>
              <div className="text-xl font-black font-mono text-cyan-300">{formatUsd(master.priceUsd)}</div>
            </a>
            <a
              href={lab.stripeUrl}
              onClick={() => handleBuyClick(lab.sku)}
              className="flex items-center justify-between gap-3 p-4 rounded-2xl border border-emerald-400/40 bg-emerald-950/20 hover:bg-emerald-950/40 transition"
            >
              <div>
                <div className="text-[11px] font-mono text-emerald-400 uppercase">Low-friction entry</div>
                <div className="text-sm font-bold text-white">Lab Starter · {lab.recordsCount.toLocaleString()} rows</div>
              </div>
              <div className="text-xl font-black font-mono text-emerald-300">{formatUsd(lab.priceUsd)}</div>
            </a>
          </div>

          {/* Comparison table */}
          <div className="mb-10 overflow-x-auto rounded-2xl border border-white/10 bg-zinc-950/80">
            <table className="w-full text-left text-xs font-mono border-collapse min-w-[640px]">
              <thead>
                <tr className="border-b border-white/10 text-zinc-400 bg-white/[0.02]">
                  <th className="py-3 px-4">Product</th>
                  <th className="py-3 px-4 text-right">Rows</th>
                  <th className="py-3 px-4 text-right">Tokens est.</th>
                  <th className="py-3 px-4 text-right">Price</th>
                  <th className="py-3 px-4 text-right">$/1k records</th>
                  <th className="py-3 px-4 text-right">Buy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {orderedProducts.map((p) => {
                  const highlight = p.sku === 'master-210k' || p.sku === 'lab-starter-2k';
                  return (
                    <tr
                      key={p.sku}
                      className={
                        p.sku === 'master-210k'
                          ? 'bg-cyan-950/25'
                          : p.sku === 'lab-starter-2k'
                            ? 'bg-emerald-950/20'
                            : ''
                      }
                    >
                      <td className="py-3.5 px-4">
                        <div className={`font-semibold ${highlight ? 'text-white' : 'text-zinc-300'}`}>{p.title}</div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">{p.badge}</div>
                      </td>
                      <td className="py-3.5 px-4 text-right text-zinc-200">{p.recordsCount.toLocaleString()}</td>
                      <td className="py-3.5 px-4 text-right text-zinc-400">{p.tokensEstimate}</td>
                      <td className="py-3.5 px-4 text-right font-bold text-white">{formatUsd(p.priceUsd)}</td>
                      <td className="py-3.5 px-4 text-right text-zinc-300">{formatPer1k(pricePer1k(p))}</td>
                      <td className="py-3.5 px-4 text-right">
                        <a
                          href={p.stripeUrl}
                          onClick={() => handleBuyClick(p.sku)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold text-[11px] transition ${
                            p.sku === 'master-210k'
                              ? 'bg-cyan-400 text-black hover:bg-cyan-300'
                              : p.sku === 'lab-starter-2k'
                                ? 'bg-emerald-400 text-black hover:bg-emerald-300'
                                : 'bg-white/10 text-white hover:bg-white/20'
                          }`}
                        >
                          <Lock size={12} /> {formatUsd(p.priceUsd)}
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Product cards — all five from DATASET_PRODUCTS */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Master hero card */}
            <div className="lg:col-span-2 relative overflow-hidden rounded-3xl border-2 border-cyan-400/40 bg-gradient-to-b from-cyan-950/20 via-zinc-950 to-black p-8 sm:p-10 shadow-[0_0_50px_rgba(0,229,255,0.15)]">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono font-bold bg-cyan-400 text-black">
                  <Sparkles size={13} /> {master.badge}
                </div>
                <div className="text-right">
                  <div className="text-3xl sm:text-4xl font-black text-white font-mono">
                    {formatUsd(master.priceUsd)}{' '}
                    <span className="text-xs font-normal text-zinc-400">USD</span>
                  </div>
                  <div className="text-[11px] font-mono text-zinc-500">
                    {master.recordsCount.toLocaleString()} rows · {master.tokensEstimate}
                  </div>
                </div>
              </div>

              <h3 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">{master.title}</h3>
              <p className="text-zinc-300 text-sm sm:text-base mb-6 max-w-3xl leading-relaxed">{master.description}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
                {master.features.map((feat, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-xs text-zinc-200">
                    <Check size={16} className="text-cyan-400 shrink-0 mt-0.5" />
                    <span>{feat}</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-white/10">
                {masterPaidSession ? (
                  <a
                    href={`/api/datasets/download?sku=${encodeURIComponent(master.sku)}&session_id=${encodeURIComponent(masterPaidSession)}`}
                    className="inline-flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-extrabold text-sm tracking-wide transition-all shadow-sm"
                  >
                    <Download size={16} /> Download
                  </a>
                ) : null}
                <a
                  href={master.stripeUrl}
                  onClick={() => handleBuyClick(master.sku)}
                  className="inline-flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-gradient-to-r from-cyan-400 to-emerald-400 text-black font-extrabold text-sm tracking-wide hover:opacity-90 active:scale-95 transition-all shadow-[0_0_30px_rgba(0,229,255,0.3)]"
                >
                  <Lock size={16} /> Instant Stripe Checkout ({formatUsd(master.priceUsd)})
                </a>
                <span className="text-xs font-mono text-zinc-500">
                  Includes 4 LoRAs · {master.archiveSizeMb} MB archive
                </span>
              </div>
            </div>

            {/* Lab Starter entry card */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-emerald-950/30 via-zinc-950 to-black border border-emerald-400/35 flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="max-w-2xl">
                <div className="inline-flex items-center gap-2 text-[11px] font-mono font-bold text-emerald-400 uppercase tracking-wider mb-2">
                  <Zap size={13} /> {lab.badge}
                </div>
                <h3 className="text-xl font-bold text-white mb-2">{lab.title}</h3>
                <p className="text-xs text-zinc-400 leading-relaxed mb-4">{lab.description}</p>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {lab.features.slice(0, 4).map((feat, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-zinc-300">
                      <Check size={14} className="text-emerald-400" />
                      <span>{feat}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4 shrink-0">
                <div className="text-left sm:text-right">
                  <div className="text-2xl font-black text-white font-mono">
                    {formatUsd(lab.priceUsd)}{' '}
                    <span className="text-xs font-normal text-zinc-400">USD</span>
                  </div>
                  <div className="text-[11px] font-mono text-zinc-500">
                    {lab.recordsCount.toLocaleString()} rows · {lab.tokensEstimate}
                  </div>
                </div>
                <a
                  href={lab.stripeUrl}
                  onClick={() => handleBuyClick(lab.sku)}
                  className="inline-flex items-center gap-2 px-6 py-3.5 rounded-xl bg-emerald-400 hover:bg-emerald-300 text-black font-bold text-xs transition"
                >
                  <Lock size={14} /> Buy Lab Starter ({formatUsd(lab.priceUsd)})
                </a>
              </div>
            </div>

            {/* Remaining domain packs */}
            {(['systems-93k', 'fullstack-102k', 'agents-15k'] as const).map((sku) => {
              const p = DATASET_PRODUCTS[sku];
              const accent =
                sku === 'systems-93k'
                  ? { badge: 'text-cyan-400', check: 'text-cyan-400', btn: 'bg-cyan-500 hover:bg-cyan-400 text-black' }
                  : sku === 'fullstack-102k'
                    ? { badge: 'text-emerald-400', check: 'text-emerald-400', btn: 'bg-emerald-500 hover:bg-emerald-400 text-black' }
                    : { badge: 'text-purple-400', check: 'text-purple-400', btn: 'bg-purple-500 hover:bg-purple-400 text-white' };
              return (
                <div
                  key={sku}
                  className={`p-8 rounded-3xl bg-zinc-950 border border-white/10 flex flex-col justify-between hover:border-cyan-500/30 transition ${
                    sku === 'agents-15k' ? 'lg:col-span-2' : ''
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-4">
                      <span className={`text-[11px] font-mono font-bold uppercase tracking-wider ${accent.badge}`}>
                        {p.badge}
                      </span>
                      <div className="text-2xl font-black text-white font-mono">
                        {formatUsd(p.priceUsd)}{' '}
                        <span className="text-xs font-normal text-zinc-400">USD</span>
                      </div>
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2">{p.title}</h3>
                    <p className="text-xs text-zinc-400 leading-relaxed mb-6">{p.description}</p>
                    <div className={`space-y-2.5 mb-6 ${sku === 'agents-15k' ? 'sm:flex sm:flex-wrap sm:gap-x-6 sm:gap-y-2 sm:space-y-0' : ''}`}>
                      {(sku === 'agents-15k' ? p.features.slice(0, 3) : p.features).map((feat, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-zinc-300">
                          <Check size={14} className={`${accent.check} shrink-0 mt-0.5`} />
                          <span>{feat}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="pt-4 border-t border-white/10 flex items-center justify-between gap-3">
                    <a
                      href={p.stripeUrl}
                      onClick={() => handleBuyClick(p.sku)}
                      className={`inline-flex items-center gap-2 px-5 py-3 rounded-xl font-bold text-xs transition ${accent.btn}`}
                    >
                      <Lock size={14} /> Buy ({formatUsd(p.priceUsd)})
                    </a>
                    <span className="text-[11px] font-mono text-zinc-500 text-right">
                      {p.recordsCount.toLocaleString()} rows · {p.tokensEstimate}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* PYTHON QUICKSTART */}
        <div className="mb-16 p-8 rounded-3xl bg-zinc-950/90 border border-white/10">
          <div className="flex items-center gap-2 text-xs font-mono text-cyan-400 uppercase tracking-widest mb-2">
            <Terminal size={16} /> Developer Quickstart
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">
            Load into PyTorch / Hugging Face / Axolotl / Unsloth
          </h2>
          <p className="text-xs text-zinc-400 max-w-3xl mb-6">
            Stream a purchased commercial archive into your fine-tuning pipeline.
          </p>

          <div className="p-5 rounded-2xl bg-black border border-cyan-500/30 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono font-bold text-cyan-300 flex items-center gap-1.5">
                    ⚡ Full Master Suite ({master.recordsCount.toLocaleString()} Records + 4 LoRAs)
                  </span>
                  <span className="text-[11px] font-mono text-emerald-400 font-bold">Enterprise JSONL</span>
                </div>
                <pre className="p-4 rounded-xl bg-zinc-950 border border-white/5 font-mono text-xs text-cyan-200 overflow-x-auto leading-relaxed">
{`from datasets import load_dataset

# Load complete downloaded archive into TRL / Axolotl:
ds_full = load_dataset(
    "json",
    data_files="payload_master_210k.tar.gz",
    split="train"
)
print(f"Loaded {len(ds_full):,} System-2 records")`}
                </pre>
              </div>
              <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between">
                <span className="text-[11px] font-mono text-zinc-500">Supports HTTP Range resume & R2</span>
                <a
                  href="#pricing"
                  className="text-xs font-mono text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                >
                  View Licenses <ArrowRight size={12} />
                </a>
              </div>
            </div>
          </div>

        {/* CLAIM ORDER */}
        <div className="mb-16 p-8 rounded-3xl bg-zinc-950 border border-white/10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="max-w-xl">
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400 uppercase tracking-widest mb-2">
              <Key size={16} /> Restore Past Purchase
            </div>
            <h3 className="text-lg font-bold text-white mb-1">
              Already purchased a dataset?
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Enter your Stripe Checkout Session ID (starts with cs_live_ or cs_test_) to verify payment and unlock downloads in this browser.
            </p>
            {claimStatus && (
              <div className={`mt-3 text-xs font-mono ${claimFailed ? 'text-rose-400' : 'text-emerald-400'}`}>
                {claimStatus}
              </div>
            )}
          </div>

          <form onSubmit={handleClaimOrder} className="flex items-center gap-2 w-full md:w-auto">
            <input
              type="text"
              value={claimInput}
              onChange={(e) => setClaimInput(e.target.value)}
              placeholder="cs_live_… or cs_test_…"
              disabled={claiming}
              className="px-4 py-2.5 rounded-xl bg-black border border-white/20 text-xs font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-400 min-w-[240px] disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={claiming}
              className="px-4 py-2.5 rounded-xl bg-white/[0.1] hover:bg-white/[0.2] text-white font-bold text-xs shrink-0 transition disabled:opacity-50"
            >
              {claiming ? 'Verifying…' : 'Claim & Unlock'}
            </button>
          </form>
        </div>

        {/* FAQ */}
        <div className="p-8 rounded-3xl bg-zinc-950/60 border border-white/10">
          <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
            <HelpCircle size={20} className="text-cyan-400" /> Frequently Asked Questions
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs text-zinc-400">
            <div>
              <div className="font-semibold text-white mb-1">What format are the datasets provided in?</div>
              <p className="leading-relaxed">
                All records are delivered in standardized compressed JSONL (.jsonl in .tar.gz archives). Each row includes system directives, multi-turn tool conversations, and &lt;thought&gt; chain-of-thought blocks compatible with Unsloth, Axolotl, Llama-Factory, and Hugging Face TRL.
              </p>
            </div>
            <div>
              <div className="font-semibold text-white mb-1">What are the commercial licensing terms?</div>
              <p className="leading-relaxed">
                Purchased packages grant a perpetual, non-exclusive, worldwide license for internal model training, benchmarking, and commercial deployment and distribution of fine-tuned model weights with zero royalties.
              </p>
            </div>
            <div>
              <div className="font-semibold text-white mb-1">Can I pay via corporate invoice or wire transfer?</div>
              <p className="leading-relaxed">
                Yes. For purchase orders (POs), corporate invoicing, or custom multi-node agreements, reach out directly to <a href="mailto:james@swarmagents.codes" className="text-cyan-300 underline">james@swarmagents.codes</a>.
              </p>
            </div>
            <div>
              <div className="font-semibold text-white mb-1">How do re-downloads work?</div>
              <p className="leading-relaxed">
                Once purchased, the license is bound to your account vault on SwarmAgents. You can return to this page anytime to stream direct downloads of your archives.
              </p>
            </div>
          </div>
        </div>
      </main>
      </ConsoleShell>
  );
}
