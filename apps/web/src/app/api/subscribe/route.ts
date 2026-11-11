import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createElement } from 'react';
import SwarmAgentsEmail from '@/emails/SwarmAgentsEmail';

// ── Resend client ──────────────────────────────────────────────────────────
// Set RESEND_API_KEY in your .env file.
// Get your free key at: https://resend.com (3,000 emails/month free)
// Lazy-initialized inside handler so missing key doesn't crash the build.

// ── Simple in-memory subscriber store ─────────────────────────────────────
// For production: replace with a database (Supabase, PlanetScale, etc.)
// This persists for the lifetime of the server process.
const subscribers = new Set<string>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email ?? '').trim().toLowerCase();

    // Basic validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email address.' }, { status: 400 });
    }

    // Already subscribed — silently succeed (no info leak)
    if (subscribers.has(email)) {
      return NextResponse.json({ success: true, message: 'Already subscribed.' });
    }

    // Store subscriber
    subscribers.add(email);
    console.log(`[subscribe] New subscriber: ${email} (total: ${subscribers.size})`);

    // Send welcome email via Resend
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey && apiKey !== 'REPLACE_WITH_RESEND_KEY') {
      const resend = new Resend(apiKey);
      const { error } = await resend.emails.send({
        from: 'SwarmAgents <dispatch@swarmagents.codes>',
        to: [email],
        subject: '⚡ Singularity Dispatch — You\'re in the loop',
        react: createElement(SwarmAgentsEmail, {
          type: 'welcome',
          ctaLabel: 'Open the Dashboard',
          ctaUrl: 'https://swarmagents.codes/dashboard',
        }),
      });

      if (error) {
        console.error('[subscribe] Resend error:', error);
        // Don't fail the request — subscriber is saved, email just didn't send
      }
    } else {
      console.warn('[subscribe] RESEND_API_KEY not set — skipping welcome email send.');
    }

    return NextResponse.json({
      success: true,
      message: 'Subscribed successfully. Welcome email dispatched.',
    });

  } catch (err) {
    console.error('[subscribe] Unexpected error:', err);
    return NextResponse.json({ error: 'Subscription failed. Try again.' }, { status: 500 });
  }
}

// GET: Return subscriber count (useful for admin monitoring)
export async function GET() {
  return NextResponse.json({ count: subscribers.size });
}
