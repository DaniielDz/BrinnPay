import type { Metadata } from 'next';

import { AuthProvider } from '../components/auth/auth-provider';

import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/public.css';
import '../styles/docs.css';
import '../styles/auth.css';
import '../styles/dashboard.css';

export const metadata: Metadata = {
  title: 'BrinnPay',
  description: 'Payment infrastructure sandbox for developers.',
  // Favicon and social-preview metadata (ui-polish D5): assets are served by
  // the app itself under the existing CSP (img-src 'self'; ADR-0028) — no
  // external CDNs. No OG image: metadata-only per D5's minimal resolution.
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }] },
  openGraph: {
    type: 'website',
    siteName: 'BrinnPay',
    title: 'BrinnPay',
    description: 'Payment infrastructure sandbox for developers.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
