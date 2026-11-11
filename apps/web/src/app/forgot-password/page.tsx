'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, Mail } from 'lucide-react';
import { requestPasswordReset } from '@/lib/auth';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(email.trim());
    setBusy(false);
    if (result.ok === false) {
      setError(result.error.error || 'Could not send reset email');
      return;
    }
    setSent(true);
  };

  return (
    <div className="min-h-screen bg-[#020204] text-white flex items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md border border-cyan-500/15 rounded-2xl bg-[#040408]/90 backdrop-blur-md p-8 shadow-2xl"
      >
        <Link href="/login" className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 mb-6">
          <ArrowLeft size={12} /> Back to Sign In
        </Link>

        <h1 className="text-2xl font-bold tracking-tight mb-1">Reset Password</h1>
        <p className="text-xs text-white/40 mb-6">
          Enter your email address to receive password reset instructions.
        </p>

        {sent ? (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-emerald-300 text-xs flex items-start gap-3">
            <CheckCircle2 size={18} className="shrink-0 text-emerald-400 mt-0.5" />
            <div>
              <p className="font-semibold text-emerald-200">Recovery email sent!</p>
              <p className="mt-1 text-emerald-300/80">
                If an account exists for <span className="underline font-mono">{email}</span>, password reset instructions have been dispatched.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="text-[10px] font-mono uppercase text-white/35 block mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator@domain.com"
                  className="w-full bg-black/40 border border-white/[0.08] rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-cyan-500/40"
                />
              </div>
            </div>

            {error && (
              <p className="text-xs text-rose-300 font-mono bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="tactile-primary w-full inline-flex items-center justify-center gap-2 text-sm py-2.5 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              {busy ? 'Sending Instructions…' : 'Send Reset Link'}
            </button>
          </form>
        )}
      </motion.div>
    </div>
  );
}
