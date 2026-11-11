'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2, Download, ShieldCheck, Copy, Check, ArrowRight, HardDrive, Key, FileCode, RefreshCw, AlertTriangle, Loader2
} from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import { DATASET_PRODUCTS, saveUnlockedLicense } from '@/lib/datasetPurchases';

type VerifyState =
  | { status: 'loading' }
  | { status: 'ok'; email?: string | null; amount_total?: number | null }
  | { status: 'error'; message: string };

function ThanksContent() {
  const searchParams = useSearchParams();
  const sku = searchParams.get('sku') || 'master-210k';
  const sessionId = searchParams.get('session_id') || '';
  const product = DATASET_PRODUCTS[sku] || DATASET_PRODUCTS['master-210k'];

  const [copied, setCopied] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [verify, setVerify] = useState<VerifyState>({ status: 'loading' });

  const downloadUrl = `/api/datasets/download?sku=${encodeURIComponent(product.sku)}&session_id=${encodeURIComponent(sessionId)}`;

  useEffect(() => {
    let cancelled = false;

    async function runVerify() {
      if (!sessionId) {
        if (!cancelled) {
          setVerify({
            status: 'error',
            message: 'Missing Stripe session_id. Return from checkout or contact support.',
          });
        }
        return;
      }

      try {
        const res = await fetch('/api/datasets/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, sku: product.sku }),
        });
        const data = await res.json().catch(() => ({}));

        if (cancelled) return;

        if (!res.ok || !data?.ok) {
          setVerify({
            status: 'error',
            message: data?.error || 'Payment not verified',
          });
          return;
        }

        setVerify({
          status: 'ok',
          email: data.customer_email,
          amount_total: data.amount_total,
        });
        saveUnlockedLicense(product.sku, sessionId, data.customer_email || undefined);

        // Auto-trigger download only after verified payment
        window.setTimeout(() => {
          if (cancelled) return;
          const link = document.createElement('a');
          link.href = downloadUrl;
          link.setAttribute('download', product.archiveFileName);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setDownloadStarted(true);
        }, 1200);
      } catch (err) {
        if (!cancelled) {
          setVerify({
            status: 'error',
            message: err instanceof Error ? err.message : 'Payment verification failed',
          });
        }
      }
    }

    runVerify();
    return () => {
      cancelled = true;
    };
  }, [product.sku, sessionId, downloadUrl, product.archiveFileName]);

  const handleCopyCommand = () => {
    navigator.clipboard.writeText(`tar -xzvf ${product.archiveFileName}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (verify.status === 'loading') {
    return (
      <div className="min-h-screen bg-[#050508] text-zinc-100 font-sans pb-24">
        <SiteHeader subtitle="Verifying payment…" />
        <main className="max-w-4xl mx-auto px-5 pt-24 flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
          <h1 className="text-2xl font-bold text-white">Confirming Stripe payment…</h1>
          <p className="text-zinc-400 text-sm max-w-md">
            Please wait while we verify your checkout session before unlocking the download.
          </p>
        </main>
      </div>
    );
  }

  if (verify.status === 'error') {
    return (
      <div className="min-h-screen bg-[#050508] text-zinc-100 font-sans pb-24">
        <SiteHeader subtitle="Payment not verified" />
        <main className="max-w-4xl mx-auto px-5 pt-12">
          <div className="relative overflow-hidden rounded-3xl border border-rose-500/30 bg-gradient-to-b from-rose-950/30 via-black/60 to-black p-8 md:p-12">
            <div className="flex items-center gap-3 text-rose-400 font-mono text-xs uppercase tracking-widest mb-4">
              <AlertTriangle size={18} />
              Payment not verified
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight mb-4">
              We could not confirm this purchase
            </h1>
            <p className="text-zinc-400 text-base mb-4 max-w-2xl leading-relaxed">
              {verify.message}
            </p>
            <p className="text-zinc-500 text-sm mb-8">
              No download was started. If you were charged, email{' '}
              <a className="text-cyan-300 underline" href="mailto:james@swarmagents.codes">
                james@swarmagents.codes
              </a>{' '}
              with your receipt and session id.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/datasets"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-white font-medium text-sm"
              >
                Back to Datasets
              </Link>
              <a
                href="mailto:james@swarmagents.codes"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl bg-rose-500/20 border border-rose-500/40 text-rose-200 font-medium text-sm"
              >
                Contact support
              </a>
            </div>
            {sessionId ? (
              <p className="mt-6 text-[11px] font-mono text-zinc-600 break-all">session_id: {sessionId}</p>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050508] text-zinc-100 font-sans pb-24">
      <SiteHeader subtitle="Order Confirmed & License Granted" />

      <main className="max-w-4xl mx-auto px-5 pt-12">
        {/* SUCCESS HERO CARD */}
        <div className="relative overflow-hidden rounded-3xl border border-emerald-500/30 bg-gradient-to-b from-emerald-950/20 via-black/60 to-black p-8 md:p-12 shadow-[0_0_50px_rgba(16,185,129,0.15)]">
          <div className="flex items-center gap-3 text-emerald-400 font-mono text-xs uppercase tracking-widest mb-4">
            <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 animate-ping" />
            <CheckCircle2 size={18} className="text-emerald-400" />
            Stripe Payment Verified & Licensed
          </div>

          <h1 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight mb-4">
            Thank you! Your dataset is ready.
          </h1>

          <p className="text-zinc-400 text-base sm:text-lg mb-8 max-w-2xl leading-relaxed">
            Your commercial license has been provisioned
            {verify.email ? ` for ${verify.email}` : ''}. Your download should begin automatically. If not, use the direct button below.
          </p>

          {/* PRODUCT SPECS PANEL */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/10">
              <div className="text-xs font-mono text-zinc-500 uppercase mb-1">Licensed Product</div>
              <div className="text-sm font-semibold text-white truncate">{product.title}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/10">
              <div className="text-xs font-mono text-zinc-500 uppercase mb-1">Total Scale</div>
              <div className="text-sm font-semibold text-cyan-300 font-mono">{product.recordsCount.toLocaleString()} Records ({product.tokensEstimate})</div>
            </div>
            <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/10">
              <div className="text-xs font-mono text-zinc-500 uppercase mb-1">Archive Size</div>
              <div className="text-sm font-semibold text-emerald-300 font-mono">{product.archiveSizeMb} MB (.tar.gz)</div>
            </div>
          </div>

          {/* DIRECT ACTION BUTTONS */}
          <div className="flex flex-wrap items-center gap-4">
            <a
              href={downloadUrl}
              className="inline-flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-emerald-500 text-black font-bold text-sm tracking-wide hover:bg-emerald-400 active:scale-95 transition-all shadow-[0_0_30px_rgba(16,185,129,0.3)]"
            >
              <Download size={18} />
              Download Archive ({product.archiveSizeMb} MB)
            </a>

            <Link
              href="/datasets"
              className="inline-flex items-center gap-2 px-6 py-4 rounded-2xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-white font-medium text-sm transition-all"
            >
              <Key size={16} className="text-cyan-400" />
              View Account Vault
            </Link>
          </div>

          {downloadStarted && (
            <div className="mt-4 flex items-center gap-2 text-xs font-mono text-emerald-400/80">
              <RefreshCw size={12} className="animate-spin" />
              Direct stream initiated from high-speed storage server.
            </div>
          )}
        </div>

        {/* UNPACKING INSTRUCTIONS & INTEGRITY */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-6 rounded-2xl bg-zinc-950/60 border border-white/10">
            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-cyan-400 mb-3">
              <FileCode size={16} /> Quick Unpack Command
            </div>
            <p className="text-xs text-zinc-400 mb-3">
              Uncompress the complete payload with verification manifests and LoRA weights:
            </p>
            <div className="flex items-center justify-between p-3 rounded-xl bg-black border border-white/10 font-mono text-xs text-zinc-200">
              <code>tar -xzvf {product.archiveFileName}</code>
              <button
                type="button"
                onClick={handleCopyCommand}
                className="p-1.5 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition"
              >
                {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-zinc-950/60 border border-white/10">
            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-400 mb-3">
              <ShieldCheck size={16} /> Commercial EULA Active
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              This license grants perpetual, worldwide, non-exclusive rights for internal model training, evaluation, fine-tuning, and commercial deployment/distribution of derived model weights.
            </p>
          </div>
        </div>

        {/* RE-DOWNLOAD VAULT CALLOUT */}
        <div className="mt-8 p-6 rounded-2xl bg-cyan-950/10 border border-cyan-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-white flex items-center gap-2">
              <HardDrive size={16} className="text-cyan-400" />
              Saved in Your SwarmAgents Account Vault
            </div>
            <div className="text-xs text-zinc-400 mt-1">
              You can return to the Datasets tab on SwarmAgents anytime to re-download your licensed files.
            </div>
          </div>
          <Link
            href="/datasets"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-300 hover:text-cyan-200 underline font-mono"
          >
            Go to Datasets Hub <ArrowRight size={14} />
          </Link>
        </div>
      </main>
    </div>
  );
}

export default function ThanksPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#050508] flex items-center justify-center text-zinc-500 font-mono">Loading order verification...</div>}>
      <ThanksContent />
    </Suspense>
  );
}
