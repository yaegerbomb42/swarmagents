import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Outfit } from 'next/font/google';
import './globals.css';
import '../styles/neon.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { GlobalOmnibar } from '@/components/CommandPalette';

// Landing/marketing display headings only (font-display).
const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['300', '400', '500', '600', '700'],
});

const sans = Geist({
  subsets: ['latin'],
  variable: '--font-sans',
});

const mono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'SwarmAgents — A company of agents on your models',
  description:
    'Decompose huge goals, spawn concurrent agents, and ship through a shared workspace. Like Cursor for a whole engineering org.',
  icons: {
    icon: [
      { url: '/brand/mark.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/brand/icon.png', type: 'image/png' },
    ],
    apple: '/brand/mark.svg',
  },
  openGraph: {
    title: 'SwarmAgents — A company of agents on your models',
    description:
      'Decompose huge goals, spawn concurrent agents, and ship through a shared workspace.',
    siteName: 'SwarmAgents',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${outfit.variable} bg-bg-0 text-fg-1`}>
      <body className="min-h-screen w-full antialiased font-sans">
        <ThemeProvider>{children}<GlobalOmnibar /></ThemeProvider>
      </body>
    </html>
  );
}
