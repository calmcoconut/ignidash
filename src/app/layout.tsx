import type { Metadata, Viewport } from 'next';
import { Figtree, Geist_Mono, Geist } from 'next/font/google';

import { ThemeProvider } from '@/components/providers/theme-provider';
import { getToken } from '@/lib/auth-server';

import { ConvexClientProvider } from './convex-client-provider';
import './globals.css';

const figtree = Figtree({
  variable: '--font-figtree',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const geist = Geist({
  variable: '--font-geist',
  subsets: ['latin'],
});

const siteConfig = {
  name: 'Ignidash',
  description: 'Plan your path to Financial Independence and Early Retirement with AI-powered insights and comprehensive simulations.',
  ogImage: '/og-image.webp',
};

/** Absolute base for metadata URLs. A self-hosted deployment sets SITE_URL; localhost otherwise. */
const siteUrl = process.env.SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  title: {
    default: `${siteConfig.name} - AI-Powered FIRE Calculator`,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  publisher: siteConfig.name,
  manifest: '/site.webmanifest',
  metadataBase: new URL(siteUrl),
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: siteConfig.name,
    title: `${siteConfig.name} - AI-Powered FIRE Calculator`,
    description: siteConfig.description,
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: `${siteConfig.name} - FIRE Planning Made Smarter`,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${siteConfig.name} - AI-Powered FIRE Calculator`,
    description: siteConfig.description,
    images: [siteConfig.ogImage],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  applicationName: siteConfig.name,
  category: 'personal finance',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#27272a' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebApplication',
      name: 'Ignidash',
      description: 'Plan your path to Financial Independence and Early Retirement with AI-powered insights and comprehensive simulations.',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      featureList: ['Monte Carlo simulations', 'Historical backtesting', 'Tax estimation', 'AI-powered insights', 'AI chat'],
    },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const initialToken = await getToken();

  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className={`${figtree.variable} ${geistMono.variable} ${geist.variable} h-full antialiased`}>
        <script
          type="application/ld+json"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
          }}
        />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ConvexClientProvider initialToken={initialToken}>{children}</ConvexClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
