'use client';

import Link from 'next/link';
import { Mail, Shield, FileText, Info, HelpCircle } from 'lucide-react';
import Wordmark from '@/components/brand/Wordmark';

export default function SiteFooter() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="relative z-10 border-t border-[#18181b] bg-[#09090b] text-[#a1a1aa] px-5 py-12 md:py-16">
      <div className="max-w-6xl mx-auto flex flex-col gap-10">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 md:gap-12">
          {/* Brand & Email Section */}
          <div className="md:col-span-2 flex flex-col gap-4">
            <Wordmark size={24} textClassName="text-base font-semibold tracking-tight font-mono" />
            <p className="text-sm text-[#71717a] max-w-sm leading-relaxed">
              Autonomous multi-agent orchestration substrate for parallel goal decomposition and agent spawning on your own models.
            </p>
            <div className="pt-2">
              <span className="text-xs uppercase tracking-wider text-[#71717a] font-mono block mb-1.5">
                Official Support Email
              </span>
              <a
                href="mailto:support@swarmagents.codes"
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#18181b] border border-[#27272a] text-xs font-mono text-cyan-300 hover:text-cyan-200 hover:border-cyan-500/40 hover:bg-cyan-950/20 transition-all group shadow-sm"
              >
                <Mail size={14} className="text-cyan-400 group-hover:scale-110 transition-transform" />
                <span>support@swarmagents.codes</span>
              </a>
            </div>
          </div>

          {/* Navigation Links */}
          <div className="flex flex-col gap-3">
            <h4 className="text-xs font-mono uppercase tracking-wider text-[#fafafa] font-semibold">
              Company & Legal
            </h4>
            <ul className="flex flex-col gap-2.5 text-sm">
              <li>
                <Link
                  href="/about"
                  className="flex items-center gap-2 hover:text-[#fafafa] transition-colors"
                >
                  <Info size={14} className="text-[#52525b]" />
                  <span>About Us</span>
                </Link>
              </li>
              <li>
                <Link
                  href="/contact"
                  className="flex items-center gap-2 hover:text-[#fafafa] transition-colors"
                >
                  <HelpCircle size={14} className="text-[#52525b]" />
                  <span>Contact Us</span>
                </Link>
              </li>
              <li>
                <Link
                  href="/terms"
                  className="flex items-center gap-2 hover:text-[#fafafa] transition-colors"
                >
                  <FileText size={14} className="text-[#52525b]" />
                  <span>Terms of Service</span>
                </Link>
              </li>
              <li>
                <Link
                  href="/privacy"
                  className="flex items-center gap-2 hover:text-[#fafafa] transition-colors"
                >
                  <Shield size={14} className="text-[#52525b]" />
                  <span>Privacy Policy</span>
                </Link>
              </li>
              <li>
                <Link
                  href="/data-deletion"
                  className="flex items-center gap-2 hover:text-[#fafafa] transition-colors"
                >
                  <Shield size={14} className="text-[#52525b]" />
                  <span>Data deletion</span>
                </Link>
              </li>
            </ul>
          </div>

          {/* Console & Quick Links */}
          <div className="flex flex-col gap-3">
            <h4 className="text-xs font-mono uppercase tracking-wider text-[#fafafa] font-semibold">
              Platform
            </h4>
            <ul className="flex flex-col gap-2.5 text-sm">
              <li>
                <Link href="/docs" className="hover:text-[#fafafa] transition-colors">
                  Docs
                </Link>
              </li>
              <li>
                <Link href="/pricing" className="hover:text-[#fafafa] transition-colors">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/datasets" className="hover:text-[#fafafa] transition-colors">
                  Datasets
                </Link>
              </li>
              <li>
                <Link href="/decomp" className="hover:text-[#fafafa] transition-colors">
                  Console / Workbench
                </Link>
              </li>
              <li>
                <Link href="/billing" className="hover:text-[#fafafa] transition-colors">
                  Billing & Quota
                </Link>
              </li>
              <li>
                <Link href="/login" className="hover:text-[#fafafa] transition-colors">
                  Sign In
                </Link>
              </li>
              <li>
                <Link href="/signup?next=/decomp" className="hover:text-[#fafafa] transition-colors">
                  Create Account
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom copyright bar */}
        <div className="pt-8 border-t border-[#18181b] flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#52525b]">
          <div className="flex items-center gap-3">
            <span>&copy; {currentYear} SwarmAgents Substrate. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Systems Operational
            </span>
            <a
              href="mailto:support@swarmagents.codes"
              className="hover:text-[#a1a1aa] transition-colors font-mono"
            >
              support@swarmagents.codes
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
