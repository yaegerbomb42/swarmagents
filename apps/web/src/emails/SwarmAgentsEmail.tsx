import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
  Row,
  Column,
  Font,
} from '@react-email/components';
import * as React from 'react';

interface SwarmAgentsEmailProps {
  type: 'welcome' | 'update';
  updateTitle?: string;
  updateBody?: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

const BRAND_CYAN = '#00d4ff';
const BRAND_TEAL = '#00b8a9';
const BG_DARK = '#040414';
const BG_CARD = '#080820';
const BORDER = '#1a1a3e';
const TEXT_PRIMARY = '#f0f4ff';
const TEXT_MUTED = '#8892b0';

export default function SwarmAgentsEmail({
  type = 'welcome',
  updateTitle = 'SwarmAgents v2 — Live Routing Engine Ships',
  updateBody = `The autonomous decomposition loop is now running 24/7 on our production cluster. DeepSeek Architect now handles recursive tree expansion with full branch validation and live worker assignment.`,
  ctaLabel = 'Open the Dashboard',
  ctaUrl = 'https://swarmagents.codes/dashboard',
}: SwarmAgentsEmailProps) {
  const isWelcome = type === 'welcome';

  const previewText = isWelcome
    ? 'You are now in the loop — SwarmAgents dispatch active.'
    : `${updateTitle} — SwarmAgents Dispatch`;

  return (
    <Html lang="en">
      <Head>
        <Font
          fontFamily="Inter"
          fallbackFontFamily="Helvetica"
          webFont={{
            url: 'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2',
            format: 'woff2',
          }}
          fontWeight={400}
          fontStyle="normal"
        />
      </Head>
      <Preview>{previewText}</Preview>

      <Body style={body}>
        {/* ── Outer wrapper ── */}
        <Container style={container}>

          {/* ── Header bar ── */}
          <Section style={headerSection}>
            <Row>
              <Column style={{ width: '36px', paddingRight: '12px', verticalAlign: 'middle' }}>
                {/* Logo mark: gradient hexagon svg inline */}
                <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect width="36" height="36" rx="8" fill="url(#logoGrad)" />
                  <path d="M18 6 L18 30 M6 18 L30 18 M9 9 L27 27 M27 9 L9 27"
                        stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
                  <defs>
                    <linearGradient id="logoGrad" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stopColor="#00d4ff"/>
                      <stop offset="100%" stopColor="#7c3aed"/>
                    </linearGradient>
                  </defs>
                </svg>
              </Column>
              <Column style={{ verticalAlign: 'middle' }}>
                <Text style={logoText}>SwarmAgents</Text>
                <Text style={logoSub}>SINGULARITY DISPATCH</Text>
              </Column>
            </Row>
          </Section>

          {/* ── Hero gradient bar ── */}
          <Section style={heroBorder} />

          {/* ── Status badge ── */}
          <Section style={{ padding: '28px 32px 0' }}>
            <Text style={badge}>
              {'● '}{isWelcome ? 'SUBSCRIPTION CONFIRMED' : 'TRANSMISSION ACTIVE'}
            </Text>
          </Section>

          {/* ── Main headline ── */}
          <Section style={{ padding: '12px 32px 0' }}>
            <Heading style={headline}>
              {isWelcome
                ? <>Welcome to the<br /><span style={{ color: BRAND_CYAN }}>Singularity Dispatch</span></>
                : <span style={{ color: TEXT_PRIMARY }}>{updateTitle}</span>
              }
            </Heading>
          </Section>

          {/* ── Body text ── */}
          <Section style={{ padding: '20px 32px 0' }}>
            <Text style={bodyText}>
              {isWelcome
                ? `You're now inside the loop. SwarmAgents is building the first multi-agent orchestration platform where each task is recursively decomposed into a branching tree — executed 24/7 by specialized local workers, verified autonomously, and merged into a finished deliverable.`
                : updateBody
              }
            </Text>
            {isWelcome && (
              <Text style={bodyText}>
                {`As a Dispatch subscriber, you'll get raw technical updates, early access windows, and first-mover pricing on credits before we launch publicly.`}
              </Text>
            )}
          </Section>

          {/* ── Feature grid (welcome only) ── */}
          {isWelcome && (
            <Section style={{ padding: '24px 32px 0' }}>
              <Row>
                {[
                  { icon: '⚡', title: 'Relentless Engine', desc: 'Plan → Act → Verify → Retry. No human required.' },
                  { icon: '🧠', title: 'DeepSeek Architect', desc: 'Cloud orchestrator breaks any objective into executable subtasks.' },
                  { icon: '🔄', title: 'DMV Recovery', desc: 'Diagnose → Mitigate → Validate self-healing on every failure.' },
                  { icon: '∞', title: 'Infinite Depth', desc: 'Tree branches split until every leaf fits a 5GB local worker.' },
                ].map((f, i) => (
                  <Column key={i} style={featureCard}>
                    <Text style={featureIcon}>{f.icon}</Text>
                    <Text style={featureTitle}>{f.title}</Text>
                    <Text style={featureDesc}>{f.desc}</Text>
                  </Column>
                ))}
              </Row>
            </Section>
          )}

          {/* ── Divider ── */}
          <Section style={{ padding: '28px 32px 0' }}>
            <Hr style={divider} />
          </Section>

          {/* ── CTA button ── */}
          <Section style={{ padding: '8px 32px 0', textAlign: 'center' as const }}>
            <Button style={ctaButton} href={ctaUrl}>
              {ctaLabel} →
            </Button>
          </Section>

          {/* ── Footer ── */}
          <Section style={{ padding: '32px 32px 24px' }}>
            <Text style={footerText}>
              You're receiving this because you subscribed at{' '}
              <a href="https://swarmagents.codes" style={{ color: BRAND_CYAN, textDecoration: 'none' }}>
                swarmagents.codes
              </a>
              . No spam, ever — only signal.
            </Text>
            <Text style={footerCopy}>
              © 2026 YAEGER / SwarmAgents · james@swarmagents.codes
            </Text>
          </Section>

        </Container>
      </Body>
    </Html>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const body: React.CSSProperties = {
  backgroundColor: '#020208',
  fontFamily: 'Inter, Helvetica, Arial, sans-serif',
  margin: '0',
  padding: '32px 0',
};

const container: React.CSSProperties = {
  backgroundColor: BG_DARK,
  border: `1px solid ${BORDER}`,
  borderRadius: '12px',
  maxWidth: '600px',
  margin: '0 auto',
  overflow: 'hidden',
};

const headerSection: React.CSSProperties = {
  padding: '24px 32px 20px',
  backgroundColor: BG_CARD,
  borderBottom: `1px solid ${BORDER}`,
};

const heroBorder: React.CSSProperties = {
  background: 'linear-gradient(90deg, #00d4ff 0%, #7c3aed 50%, #00b8a9 100%)',
  height: '2px',
  padding: '0',
};

const logoText: React.CSSProperties = {
  fontSize: '18px',
  fontWeight: '700',
  color: TEXT_PRIMARY,
  margin: '0',
  letterSpacing: '-0.3px',
};

const logoSub: React.CSSProperties = {
  fontSize: '9px',
  fontWeight: '600',
  color: BRAND_CYAN,
  letterSpacing: '0.2em',
  margin: '2px 0 0',
  opacity: 0.7,
};

const badge: React.CSSProperties = {
  fontSize: '9px',
  fontWeight: '700',
  letterSpacing: '0.18em',
  color: BRAND_CYAN,
  backgroundColor: 'rgba(0, 212, 255, 0.08)',
  border: `1px solid rgba(0, 212, 255, 0.2)`,
  borderRadius: '4px',
  padding: '4px 10px',
  display: 'inline-block',
  margin: '0',
};

const headline: React.CSSProperties = {
  fontSize: '30px',
  fontWeight: '800',
  color: TEXT_PRIMARY,
  lineHeight: '1.15',
  letterSpacing: '-0.5px',
  margin: '0',
};

const bodyText: React.CSSProperties = {
  fontSize: '15px',
  color: TEXT_MUTED,
  lineHeight: '1.7',
  margin: '0 0 14px',
};

const featureCard: React.CSSProperties = {
  width: '50%',
  padding: '12px',
  verticalAlign: 'top',
};

const featureIcon: React.CSSProperties = {
  fontSize: '22px',
  margin: '0 0 6px',
};

const featureTitle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: '700',
  color: TEXT_PRIMARY,
  margin: '0 0 4px',
  letterSpacing: '-0.1px',
};

const featureDesc: React.CSSProperties = {
  fontSize: '11px',
  color: TEXT_MUTED,
  lineHeight: '1.5',
  margin: '0',
};

const divider: React.CSSProperties = {
  borderColor: BORDER,
  margin: '0',
};

const ctaButton: React.CSSProperties = {
  background: 'linear-gradient(135deg, #00d4ff 0%, #00b8a9 100%)',
  color: '#000',
  fontSize: '13px',
  fontWeight: '700',
  padding: '14px 36px',
  borderRadius: '10px',
  textDecoration: 'none',
  letterSpacing: '0.02em',
  display: 'inline-block',
};

const footerText: React.CSSProperties = {
  fontSize: '11px',
  color: '#4a5568',
  lineHeight: '1.6',
  margin: '0 0 8px',
  textAlign: 'center' as const,
};

const footerCopy: React.CSSProperties = {
  fontSize: '10px',
  color: '#2d3748',
  margin: '0',
  textAlign: 'center' as const,
};
