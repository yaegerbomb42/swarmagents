'use client';

import { FormEvent, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowRight, Chrome, Github, Loader2, Lock, Mail, Phone, User } from 'lucide-react';
import type { ConfirmationResult } from 'firebase/auth';
import {
  confirmPhoneCode,
  getRecaptchaVerifier,
  postAuthPath,
  requestPhoneCode,
  resetRecaptchaVerifier,
  signup,
  signupWithFacebook,
  signupWithGithub,
  signupWithGoogle,
} from '@/lib/auth';

export default function SignupInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = useMemo(() => postAuthPath(params.get('next')), [params]);

  const [mode, setMode] = useState<'email' | 'phone'>('email');

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [facebookBusy, setFacebookBusy] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await signup({
      email: email.trim(),
      password,
      display_name: displayName.trim() || undefined,
    });
    setBusy(false);
    if (result.ok === false) {
      setError(result.error.error || 'Signup failed');
      return;
    }
    router.replace(next);
  };

  const onGoogle = async () => {
    setGoogleBusy(true);
    setError(null);
    const result = await signupWithGoogle();
    setGoogleBusy(false);
    if (result.ok === false) {
      setError(result.error.error || 'Google sign-up failed');
      return;
    }
    router.replace(next);
  };

  const onFacebook = async () => {
    setFacebookBusy(true);
    setError(null);
    const result = await signupWithFacebook();
    setFacebookBusy(false);
    if (result.ok === false) {
      setError(result.error.error || 'Facebook sign-up failed');
      return;
    }
    router.replace(next);
  };

  const onGithub = async () => {
    setGithubBusy(true);
    setError(null);
    const result = await signupWithGithub();
    setGithubBusy(false);
    if (result.ok === false) {
      setError(result.error.error || 'GitHub sign-up failed');
      return;
    }
    router.replace(next);
  };

  const onSendPhoneCode = async (e: FormEvent) => {
    e.preventDefault();
    const p = phone.trim();
    if (!p.startsWith('+')) {
      setError('Use E.164 format: +15551234567');
      return;
    }
    setPhoneBusy(true);
    setError(null);
    const verifier = getRecaptchaVerifier('recaptcha-send-btn');
    const result = await requestPhoneCode(p, verifier);
    setPhoneBusy(false);
    if (result.ok === false) {
      setError(result.error.error || 'Could not send SMS');
      resetRecaptchaVerifier();
      return;
    }
    setConfirmation(result.data);
  };

  const onConfirmCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirmation) {
      setError('Request a code first');
      return;
    }
    setPhoneBusy(true);
    setError(null);
    const result = await confirmPhoneCode(confirmation, code.trim());
    setPhoneBusy(false);
    if (result.ok === false) {
      setError(result.error.error || 'Verification failed');
      return;
    }
    router.replace(next);
  };

  return (
    <div className="min-h-screen bg-[#020204] text-white flex items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md border border-cyan-500/15 rounded-2xl bg-[#040408]/90 backdrop-blur-md p-8 shadow-2xl"
      >
        <Link href="/" className="inline-flex items-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-md border border-cyan-500/30 bg-cyan-500/10 flex items-center justify-center">
            <span className="text-[11px] font-mono font-bold text-cyan-300">SA</span>
          </div>
          <span className="text-sm font-semibold tracking-tight text-cyan-100/90">SwarmAgents</span>
        </Link>

        <h1 className="text-2xl font-bold tracking-tight mb-1">Create account</h1>
        <p className="text-xs text-white/40 mb-4">
          Autonomous Swarm Identity & Workspace
        </p>
        <div className="mb-6 p-2.5 rounded-lg border border-cyan-500/20 bg-cyan-950/20 flex items-center justify-between text-xs text-cyan-200">
          <span>⚡ <strong>Sandbox Mode:</strong> Instant registration active</span>
          <button
            type="button"
            onClick={() => {
              setDisplayName('Founder / Architect');
              setEmail('founder@swarmagents.codes');
              setPassword('founder123');
              void onSubmit({ preventDefault: () => {} } as any);
            }}
            className="px-2.5 py-1 rounded bg-cyan-500 text-black font-semibold text-[11px] hover:bg-cyan-400 transition"
          >
            Instant Enter
          </button>
        </div>

        <button
          type="button"
          onClick={onGoogle}
          disabled={busy || googleBusy}
          className="w-full inline-flex items-center justify-center gap-2 text-sm py-2.5 mb-2 rounded-lg border border-white/[0.1] bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
        >
          {googleBusy ? <Loader2 size={14} className="animate-spin" /> : <Chrome size={14} />}
          {googleBusy ? 'Opening Google…' : 'Continue with Google'}
        </button>

        <button
          type="button"
          onClick={onFacebook}
          disabled={busy || facebookBusy}
          className="w-full inline-flex items-center justify-center gap-2 text-sm py-2.5 mb-2 rounded-lg border border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 text-blue-200 transition-colors disabled:opacity-50"
        >
          {facebookBusy ? <Loader2 size={14} className="animate-spin" /> : <span className="text-sm font-bold">f</span>}
          {facebookBusy ? 'Opening Facebook…' : 'Continue with Facebook'}
        </button>

        <button
          type="button"
          onClick={onGithub}
          disabled={busy || githubBusy}
          className="w-full inline-flex items-center justify-center gap-2 text-sm py-2.5 mb-4 rounded-lg border border-white/[0.1] bg-white/[0.04] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
        >
          {githubBusy ? <Loader2 size={14} className="animate-spin" /> : <Github size={14} />}
          {githubBusy ? 'Opening GitHub…' : 'Continue with GitHub'}
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[10px] font-mono uppercase text-white/25">or</span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            type="button"
            onClick={() => setMode('email')}
            className={`text-xs py-2 rounded-lg border transition-colors ${
              mode === 'email'
                ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                : 'border-white/[0.08] bg-white/[0.02] text-white/40 hover:bg-white/[0.04]'
            }`}
          >
            <Mail size={12} className="inline mr-1" /> Email
          </button>
          <button
            type="button"
            onClick={() => setMode('phone')}
            className={`text-xs py-2 rounded-lg border transition-colors ${
              mode === 'phone'
                ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                : 'border-white/[0.08] bg-white/[0.02] text-white/40 hover:bg-white/[0.04]'
            }`}
          >
            <Phone size={12} className="inline mr-1" /> Phone
          </button>
        </div>

        {mode === 'email' ? (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="text-[10px] font-mono uppercase text-white/35 block mb-1.5">
                Display name
              </label>
              <div className="relative">
                <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                <input
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-black/40 border border-white/[0.08] rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-cyan-500/40"
                />
              </div>
            </div>
            <div>
              <label className="text-[10px] font-mono uppercase text-white/35 block mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-black/40 border border-white/[0.08] rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-cyan-500/40"
                />
              </div>
            </div>
            <div>
              <label className="text-[10px] font-mono uppercase text-white/35 block mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
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
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-[10px] font-mono uppercase text-white/35 block mb-1.5">
                Phone number
              </label>
              <div className="relative">
                <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                <input
                  type="tel"
                  required
                  autoComplete="tel"
                  placeholder="+15551234567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={confirmation !== null}
                  className="w-full bg-black/40 border border-white/[0.08] rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-cyan-500/40 disabled:opacity-50"
                />
              </div>
              <p className="text-[10px] text-white/30 mt-1">
                E.164 format required. SMS rates may apply.
              </p>
            </div>

            {!confirmation ? (
              <>
                {/*
                  Invisible reCAPTCHA anchor — Firebase requires the verifier be
                  bound to a real button element. Hidden from view; never
                  clicked by the user (onSendPhoneCode triggers signInWithPhoneNumber
                  programmatically, which drives the invisible challenge).
                */}
                <button
                  id="recaptcha-send-btn"
                  type="button"
                  className="hidden"
                  aria-hidden="true"
                  tabIndex={-1}
                />
                {error && (
                  <p className="text-xs text-rose-300 font-mono bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}
                <button
                  type="button"
                  onClick={onSendPhoneCode}
                  disabled={phoneBusy || !phone.trim()}
                  className="tactile-primary w-full inline-flex items-center justify-center gap-2 text-sm py-2.5 disabled:opacity-50"
                >
                  {phoneBusy ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />}
                  {phoneBusy ? 'Sending code…' : 'Send verification code'}
                </button>
              </>
            ) : (
              <form onSubmit={onConfirmCode} className="space-y-4">
                <div>
                  <label className="text-[10px] font-mono uppercase text-white/35 block mb-1.5">
                    Verification code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    autoComplete="one-time-code"
                    placeholder="123456"
                    maxLength={8}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full bg-black/40 border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm font-mono tracking-widest focus:outline-none focus:border-cyan-500/40"
                  />
                  <p className="text-[10px] text-white/30 mt-1">
                    Sent to {phone}
                  </p>
                </div>
                {error && (
                  <p className="text-xs text-rose-300 font-mono bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={phoneBusy || code.trim().length < 6}
                  className="tactile-primary w-full inline-flex items-center justify-center gap-2 text-sm py-2.5 disabled:opacity-50"
                >
                  {phoneBusy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  {phoneBusy ? 'Verifying…' : 'Verify and create account'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmation(null);
                    setCode('');
                    setError(null);
                    resetRecaptchaVerifier();
                  }}
                  className="w-full text-xs text-white/40 hover:text-white/70 py-2"
                >
                  Change phone number
                </button>
              </form>
            )}
          </div>
        )}

        <p className="text-[11px] text-white/35 mt-6 text-center">
          Already have an account?{' '}
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="text-cyan-300 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
